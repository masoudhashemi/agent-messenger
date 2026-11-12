import { ExecutionOutput } from "./execution-output.js";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { safeDirectory } from "./project-folder.js";
import { AppError } from "./store.js";
const exec = promisify(execFile);
export class PythonSandbox {
  constructor(workspace, notify = () => {}) {
    this.workspace = workspace;
    this.notify = notify;
    this.busy = false;
    this.image = process.env.PYTHON_SANDBOX_IMAGE || "python:3.12-slim";
    this.uvImage = process.env.UV_SANDBOX_IMAGE || "relay-python-uv:0.9.11";
  }
  async status(
    image = this.workspace.environment().use_uv ? this.uvImage : this.image,
  ) {
    try {
      await exec("docker", ["info", "--format", "{{.ServerVersion}}"], {
        timeout: 5000,
      });
      await exec("docker", ["image", "inspect", image], { timeout: 5000 });
      return { ready: true, image, environment: this.workspace.environment() };
    } catch {
      return {
        ready: false,
        image,
        error:
          image === this.uvImage
            ? "Start Docker and run npm run setup:uv"
            : `Start Docker and run: docker pull ${image}`,
      };
    }
  }
  async run(path, args = [], timeout_seconds = 20, actor = null, signal) {
    if (!Array.isArray(args)) throw new AppError("args must be an array");
    this.workspace.read(path);
    if (!path.endsWith(".py")) throw new AppError("Choose a .py script");
    if (this.workspace.environment().use_uv)
      return this.uv(
        "run",
        ["python", "-B", "/workspace/" + path, ...args],
        timeout_seconds,
        actor,
        signal,
        path,
      );
    return this.execute(path, args, timeout_seconds, actor, signal);
  }
  async uv(
    action,
    args = [],
    timeout_seconds = action === "sync" ? 180 : 20,
    actor = null,
    signal,
    label = null,
  ) {
    const settings = this.workspace.environment();
    if (!settings.use_uv)
      throw new AppError(
        "Enable Use uv in the project environment settings first",
        403,
      );
    if (!this.workspace.root)
      throw new AppError("uv requires a persistent project folder");
    if (!["init", "venv", "sync", "run"].includes(action))
      throw new AppError("Unknown uv action");
    if (action === "sync" && !settings.allow_package_install)
      throw new AppError(
        "Package installation is disabled by the operator",
        403,
      );
    if (!Array.isArray(args) || (action === "run" ? !args.length : args.length))
      throw new AppError(
        "uv_run needs command arguments; other uv actions take no arguments",
      );
    this.workspace.folder.target(".venv");
    return this.execute(
      label || "uv " + action,
      args,
      timeout_seconds,
      actor,
      signal,
      action,
    );
  }
  async execute(path, args, timeout_seconds, actor, signal, uvAction = null) {
    if (this.busy)
      throw new AppError(
        "A Python execution is already running in this project",
        409,
      );
    if (
      !Array.isArray(args) ||
      args.length > 40 ||
      args.some(
        (a) => typeof a !== "string" || a.length > 1000 || a.includes("\0"),
      )
    )
      throw new AppError("args must be up to 40 short strings");
    if (
      !Number.isInteger(timeout_seconds) ||
      timeout_seconds < 1 ||
      timeout_seconds > (uvAction === "sync" ? 300 : 60)
    )
      throw new AppError(
        uvAction === "sync"
          ? "Install timeout must be 1–300 seconds"
          : "Execution timeout must be 1–60 seconds",
      );
    if (actor) this.workspace.store.agent(actor);
    if (signal?.aborted) throw new AppError("Execution cancelled");
    this.workspace.ensureWritable();
    this.busy = true;
    if (this.workspace.root) this.workspace.locked = true;
    const id = randomUUID(),
      container = "relay-python-" + id,
      started = Date.now();
    let directory, proxyName, socketVolume;
    const image = uvAction ? this.uvImage : this.image;
    let command = uvAction
      ? ["python", "-I", "/opt/relay/job.py", uvAction, ...args]
      : ["python", "-B", "/workspace/" + path, ...args];
    const extra = [];
    const record = {
      id,
      path,
      args,
      actor,
      status: "running",
      started_at: new Date().toISOString(),
      image,
      runner: uvAction ? "uv" : "python",
      uv_action: uvAction,
      network: uvAction === "sync" ? "PyPI gateway only" : "none",
      stdout: "",
      stderr: "",
      exit_code: null,
    };
    this.workspace.record(record);
    this.notify();
    try {
      const ready = await this.status(image);
      if (!ready.ready) throw new AppError(ready.error, 503);
      if (signal?.aborted) throw new AppError("Execution cancelled");
      const snapshot = this.workspace.snapshot();
      record.revisions = Object.fromEntries(
        snapshot.map((f) => [f.path, f.revision]),
      );
      if (this.workspace.root) {
        directory = this.workspace.root;
        record.workspace_mode = "persistent";
      } else {
        directory = mkdtempSync(join(tmpdir(), "relay-python-"));
        chmodSync(directory, 0o755);
        for (const d of this.workspace.directories())
          mkdirSync(join(directory, d.path), { recursive: true, mode: 0o755 });
        for (const f of snapshot) {
          const dest = join(directory, f.path);
          mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
          writeFileSync(dest, f.content, { mode: 0o644 });
        }
      }
      if (uvAction) {
        const cache = safeDirectory(
          join(
            dirname(this.workspace.folder.gitDir),
            "..",
            "uv-cache",
            basename(this.workspace.folder.gitDir, ".git"),
          ),
        );
        extra.push("--mount", `type=bind,src=${cache},dst=/uv-cache`);
        for (const value of [
          "UV_CACHE_DIR=/uv-cache",
          "UV_PROJECT_ENVIRONMENT=/workspace/.venv",
          "UV_PYTHON_DOWNLOADS=never",
          "UV_LINK_MODE=copy",
          "UV_NO_CONFIG=1",
          "UV_HTTP_TIMEOUT=30",
          "UV_HTTP_RETRIES=1",
          "UV_NO_PROGRESS=1",
          "UV_PYTHON=/usr/local/bin/python",
          "XDG_CACHE_HOME=/uv-cache",
          "UV_TOOL_DIR=/uv-cache/tools",
        ])
          extra.push("--env", value);
      }
      if (uvAction === "sync") {
        proxyName = "relay-packages-" + id;
        socketVolume = "relay-packages-socket-" + id;
        await exec("docker", ["volume", "create", socketVolume], {
          timeout: 10000,
        });
        await exec(
          "docker",
          [
            "run",
            "-d",
            "--name",
            proxyName,
            "--read-only",
            "--memory",
            "192m",
            "--cpus",
            "0.5",
            "--pids-limit",
            "64",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--user",
            "65534:65534",
            "--tmpfs",
            "/tmp:rw,noexec,nosuid,size=16m",
            "--mount",
            `type=volume,src=${socketVolume},dst=/relay-proxy`,
            image,
            "python",
            "-I",
            "/opt/relay/package_proxy.py",
          ],
          { timeout: 15000 },
        );
        extra.push(
          "--mount",
          `type=volume,src=${socketVolume},dst=/relay-proxy,readonly`,
        );
        command = ["python", "-I", "/opt/relay/bridge.py", ...command];
      }
      await exec(
        "docker",
        [
          "create",
          "--name",
          container,
          "--network",
          "none",
          "--read-only",
          "--memory",
          uvAction === "sync" ? "512m" : "256m",
          "--memory-swap",
          uvAction === "sync" ? "512m" : "256m",
          "--cpus",
          "1",
          "--pids-limit",
          "64",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          this.workspace.root
            ? `${process.getuid?.() || 65534}:${process.getgid?.() || 65534}`
            : "65534:65534",
          "--ulimit",
          "nofile=128:128",
          "--ulimit",
          uvAction === "sync"
            ? "fsize=134217728:134217728"
            : "fsize=8388608:8388608",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=64m,mode=1777",
          "--mount",
          `type=bind,src=${directory},dst=/workspace${this.workspace.root ? "" : ",readonly"}`,
          "--workdir",
          "/workspace",
          "--env",
          "HOME=/tmp",
          "--env",
          "PYTHONDONTWRITEBYTECODE=1",
          ...extra,
          image,
          ...command,
        ],
        { timeout: 15000, maxBuffer: 8192 },
      );
      if (signal?.aborted) throw new AppError("Execution cancelled");
      let stopped = null;
      const stop = (reason) => {
        if (stopped) return;
        stopped = reason;
        void exec("docker", ["rm", "-f", container], { timeout: 5000 }).catch(
          () => {},
        );
      };
      const result = await new Promise((resolve, reject) => {
        const child = spawn("docker", ["start", "--attach", container], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const output = new ExecutionOutput(
          this.workspace.store.artifacts,
          record.id,
        );
        record.stdout_artifact_id = output.ids.stdout;
        record.stderr_artifact_id = output.ids.stderr;
        record.output_complete = false;
        let captureError = null;
        const capture = (stream, data) => {
          try {
            output.append(stream, data);
          } catch (error) {
            captureError = error;
            stop("capture_failed");
          }
        };
        child.stdout.on("data", (data) => capture("stdout", data));
        child.stderr.on("data", (data) => capture("stderr", data));
        const timer = setTimeout(
          () => stop("timed_out"),
          timeout_seconds * 1000,
        );
        const abort = () => stop("cancelled");
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const hardTimer = setTimeout(
          () => {
            stop("timed_out");
            child.kill("SIGKILL");
          },
          timeout_seconds * 1000 + 7000,
        );
        const clean = () => {
          clearTimeout(timer);
          clearTimeout(hardTimer);
          signal?.removeEventListener("abort", abort);
        };
        child.once("error", (e) => {
          captureError = e;
          stop("capture_failed");
          clean();
          // close still finalizes any captured output.
        });
        child.once("close", (code) => {
          clean();
          try {
            resolve({
              ...output.finish(),
              exit_code: code,
              ...(captureError
                ? {
                    output_complete: false,
                    error: "Failed to persist execution output",
                  }
                : {}),
            });
          } catch (error) {
            reject(error);
          }
        });
      });
      Object.assign(record, result, {
        status: stopped || (result.exit_code === 0 ? "succeeded" : "failed"),
      });
      if (record.status !== "succeeded")
        record.error =
          record.status === "timed_out"
            ? "Python execution exceeded its time limit"
            : record.status === "cancelled"
              ? "Python execution was cancelled"
              : record.error || `Python exited with code ${record.exit_code}`;
    } catch (e) {
      record.status = signal?.aborted ? "cancelled" : "failed";
      record.error =
        e instanceof AppError
          ? e.message
          : "Docker execution failed; check that Docker and the configured Python image are available.";
    } finally {
      let removed = true;
      try {
        await exec("docker", ["rm", "-f", container], { timeout: 5000 });
      } catch (e) {
        if (!String(e.stderr || "").includes("No such container"))
          removed = false;
      }
      if (proxyName)
        await exec("docker", ["rm", "-f", proxyName], { timeout: 5000 }).catch(
          () => {},
        );
      if (socketVolume)
        await exec("docker", ["volume", "rm", socketVolume], {
          timeout: 5000,
        }).catch(() => {});
      if (!removed && this.workspace.root) {
        record.status = "failed";
        record.error =
          "Could not confirm container removal. Workspace remains locked until Docker is recovered.";
      }
      if (directory && !this.workspace.root)
        rmSync(directory, { recursive: true, force: true });
      if (this.workspace.root && removed) {
        this.workspace.locked = false;
        try {
          if (uvAction === "sync") {
            const lock = this.workspace.folder.target("uv.lock");
            if (existsSync(lock)) {
              const content = readFileSync(lock, "utf8");
              this.workspace.folder.write(
                "uv.lock",
                content
                  .replaceAll(
                    "http://127.0.0.1:8123/files/",
                    "https://files.pythonhosted.org/",
                  )
                  .replaceAll(
                    "http://127.0.0.1:8123/simple",
                    "https://pypi.org/simple",
                  ),
              );
            }
          }
          this.workspace.sync(
            actor,
            uvAction ? "uv " + uvAction : "python",
            id,
          );
          record.changes = this.workspace
            .history()
            .filter((e) => e.execution_id === id);
          record.workspace_warnings = this.workspace.warnings;
        } catch (e) {
          record.persistence_error = e.message;
          record.status = "failed";
          record.error =
            "Python ended, but workspace history could not be updated: " +
            e.message;
        }
      }
      record.duration_ms = Date.now() - started;
      record.ended_at = new Date().toISOString();
      this.workspace.record(record);
      this.busy = false;
      this.notify();
    }
    return record;
  }
}
