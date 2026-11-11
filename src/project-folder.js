import {
  mkdirSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { resolve, join, dirname, parse } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  excludedWorkspacePath,
  managedDirectories,
} from "./workspace-exclusions.js";
import { AppError } from "./store.js";

// Git metadata is outside the writable sandbox mount. Never follow workspace symlinks.
export function safeDirectory(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute
    .slice(current.length)
    .split("/")
    .filter(Boolean)) {
    current = join(current, part);
    if (
      existsSync(current) ||
      (() => {
        try {
          return lstatSync(current).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    ) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() && current !== absolute)
        current = realpathSync(current);
      else if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new AppError(
          "Workspace folders cannot contain symlinks or files",
        );
    } else mkdirSync(current);
  }
  return realpathSync(absolute);
}
export class ProjectFolder {
  constructor(root, gitDir) {
    this.root = safeDirectory(root);
    this.gitDir = safeDirectory(gitDir);
    this.artifactCache = new Map();
    this.initialized = existsSync(join(this.gitDir, "HEAD"));
    if (!this.initialized)
      execFileSync("git", ["init", "--bare", "--quiet", this.gitDir], {
        timeout: 20000,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      });
    this.git(["config", "core.bare", "false"]);
    this.git(["config", "core.worktree", this.root]);
    this.git(["config", "core.hooksPath", "/dev/null"]);
    this.git(["config", "commit.gpgsign", "false"]);
    this.git(["config", "core.autocrlf", "false"]);
    const excludes = join(this.gitDir, "info", "exclude");
    const previous = existsSync(excludes) ? readFileSync(excludes, "utf8") : "";
    const patterns = [...managedDirectories]
      .map((d) => d + "/")
      .filter((d) => !previous.split("\n").includes(d));
    if (patterns.length)
      writeFileSync(excludes, previous + "\n" + patterns.join("\n") + "\n");
    this.link();
  }
  git(args, options = {}) {
    try {
      return execFileSync(
        "git",
        ["--git-dir=" + this.gitDir, "--work-tree=" + this.root, ...args],
        {
          encoding: "utf8",
          timeout: 20000,
          maxBuffer: 4000000,
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            ...options.env,
          },
          ...options,
        },
      ).trim();
    } catch (e) {
      throw new AppError(
        "Workspace Git operation failed: " +
          String(e.stderr || e.message).slice(0, 500),
        500,
      );
    }
  }
  link() {
    const dest = join(this.root, ".git");
    try {
      const stat = lstatSync(dest);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new AppError("Reserved .git entry must be a regular file");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    writeFileSync(dest, "gitdir: " + this.gitDir + "\n");
  }
  target(path) {
    let current = this.root;
    if (
      lstatSync(current).isSymbolicLink() ||
      realpathSync(current) !== this.root
    )
      throw new AppError("Workspace root changed");
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
          throw new AppError("Workspace links are not supported");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    return current;
  }
  mkdir(path) {
    mkdirSync(this.target(path), { recursive: true });
  }
  write(path, content) {
    const dest = this.target(path);
    mkdirSync(dirname(dest), { recursive: true });
    const temp = join(dirname(dest), ".relay-write-" + randomUUID());
    try {
      writeFileSync(temp, content, { flag: "wx" });
      renameSync(temp, dest);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  scan() {
    this.target("");
    const files = [],
      directories = [],
      warnings = [],
      unsupported = [],
      artifacts = [];
    let count = 0,
      total = 0,
      textTotal = 0;
    const walk = (dir) => {
      for (const entry of readdirSync(join(this.root, dir), {
        withFileTypes: true,
      })) {
        if (
          entry.name === ".git" ||
          managedDirectories.has(entry.name) ||
          entry.name.startsWith(".relay-write-")
        )
          continue;
        const path = dir ? dir + "/" + entry.name : entry.name;
        if (++count > 1000)
          throw new AppError("Workspace scan limit: 1,000 entries");
        if (
          path.length > 240 ||
          path.split("/").some((p) => !/^[a-zA-Z0-9_.-]+$/.test(p))
        ) {
          warnings.push("Unsupported path: " + path);
          continue;
        }
        const stat = lstatSync(join(this.root, path));
        if (
          stat.isSymbolicLink() ||
          (!stat.isDirectory() && (!stat.isFile() || stat.nlink > 1))
        ) {
          warnings.push("Skipped link or special file: " + path);
          continue;
        }
        if (stat.isDirectory()) {
          directories.push(path);
          walk(path);
          continue;
        }
        const unavailable = (reason, buf = null) => {
          if (stat.size <= 8000000 && total + stat.size <= 64000000) {
            const cached = this.artifactCache.get(path);
            const hash =
              cached &&
              cached.ino === stat.ino &&
              cached.size === stat.size &&
              cached.mtimeMs === stat.mtimeMs &&
              cached.ctimeMs === stat.ctimeMs
                ? cached.hash
                : createHash("sha256")
                    .update(buf || readFileSync(join(this.root, path)))
                    .digest("hex");
            this.artifactCache.set(path, {
              ino: stat.ino,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              ctimeMs: stat.ctimeMs,
              hash,
            });
            artifacts.push({ path, hash, bytes: stat.size });
            total += stat.size;
          } else
            reason = "Outside Git tracking limits (8 MB/file, 64 MB total)";
          warnings.push(reason + ": " + path);
          unsupported.push({
            path,
            bytes: stat.size,
            revision: 0,
            unsupported: reason,
          });
        };
        if (
          stat.size > 256000 ||
          textTotal + stat.size > 2000000 ||
          files.length >= 100
        ) {
          unavailable("Outside text indexing limits");
          continue;
        }
        const cachedArtifact = this.artifactCache.get(path);
        if (
          cachedArtifact &&
          cachedArtifact.binary &&
          cachedArtifact.ino === stat.ino &&
          cachedArtifact.size === stat.size &&
          cachedArtifact.mtimeMs === stat.mtimeMs &&
          cachedArtifact.ctimeMs === stat.ctimeMs
        ) {
          unavailable("Binary file");
          continue;
        }
        const buf = readFileSync(join(this.root, path));
        let content;
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
        } catch {
          unavailable("Binary file", buf);
          this.artifactCache.get(path) &&
            (this.artifactCache.get(path).binary = true);
          continue;
        }
        if (content.includes("\0")) {
          unavailable("Binary file", buf);
          this.artifactCache.get(path) &&
            (this.artifactCache.get(path).binary = true);
          continue;
        }
        total += buf.length;
        textTotal += buf.length;
        files.push({ path, content });
      }
    };
    walk("");
    const seenArtifacts = new Set(artifacts.map((a) => a.path));
    for (const key of this.artifactCache.keys())
      if (!seenArtifacts.has(key)) this.artifactCache.delete(key);
    return { files, directories, warnings, unsupported, artifacts };
  }
  commit(paths, message, actor, at = null) {
    const tracked = this.git(["ls-files", "-z"])
      .split("\0")
      .filter(Boolean)
      .filter(excludedWorkspacePath);
    if (tracked.length)
      this.git(["rm", "--cached", "-f", "--ignore-unmatch", "--", ...tracked]);
    paths = paths.filter((p) => !excludedWorkspacePath(p));
    if (paths.length) this.git(["add", "-f", "-A", "--", ...paths]);
    const name = actor.name.replace(/[\r\n<>]/g, " ").slice(0, 80),
      email = actor.id ? actor.id + "@agents.local" : "operator@relay.local";
    const env = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      ...(at ? { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } : {}),
    };
    this.git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        message,
      ],
      { env },
    );
    return this.git(["rev-parse", "HEAD"]);
  }
  show(commit, path) {
    if (!/^[a-f0-9]{40,64}$/.test(commit))
      throw new AppError("Invalid Git revision");
    // exec's text trimming is unsuitable for exact source reads.
    return execFileSync(
      "git",
      ["--git-dir=" + this.gitDir, "show", commit + ":" + path],
      { encoding: "utf8", maxBuffer: 1000000 },
    );
  }
}
