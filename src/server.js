import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { AppError } from "./store.js";
import { Projects } from "./projects.js";
const port = Number(process.env.PORT || 3210),
  sessions = new Set(),
  events = new Set();
const notify = () => {
  for (const r of events) r.write("data: update\n\n");
};
const projects = new Projects(
  process.env.PROJECTS_DIR || "data/projects",
  notify,
);
setInterval(() => projects.sync(), 2000).unref();
const server = http.createServer(async (req, res) => {
  const json = (data, status = 200) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  try {
    const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
    if (!hosts.includes(req.headers.host))
      throw new AppError("Invalid host", 403);
    if (
      req.headers.origin &&
      !hosts.map((h) => "http://" + h).includes(req.headers.origin)
    )
      throw new AppError("Origin denied", 403);
    const url = new URL(req.url, `http://${hosts[0]}`);
    if (
      req.method === "GET" &&
      [
        "/",
        "/style.css",
        "/app.js",
        "/format.js",
        "/diff.js",
        "/commands.js",
      ].includes(url.pathname)
    ) {
      const root = url.pathname === "/";
      if (root) {
        const token = randomBytes(32).toString("hex");
        sessions.add(token);
        res.setHeader(
          "Set-Cookie",
          `relay_session=${token}; HttpOnly; SameSite=Strict; Path=/`,
        );
      }
      res.setHeader(
        "Content-Type",
        root
          ? "text/html"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/javascript",
      );
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      );
      res.end(
        readFileSync(
          new URL(
            "../public/" + (root ? "index.html" : url.pathname.slice(1)),
            import.meta.url,
          ),
        ),
      );
      return;
    }
    const isAdmin = url.pathname.startsWith("/api/admin/"),
      isAgent = url.pathname.startsWith("/api/agent/");
    if (!isAdmin && !isAgent) throw new AppError("Not found", 404);
    if (
      isAdmin &&
      !sessions.has(
        req.headers.cookie?.match(/(?:^|; )relay_session=([^;]+)/)?.[1],
      )
    )
      throw new AppError("Operator session required", 401);
    let body = {};
    if (req.method === "POST") {
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        if (data.length > 1500000) throw new AppError("Request too large", 413);
      }
      try {
        body = JSON.parse(data || "{}");
      } catch {
        throw new AppError("Invalid JSON");
      }
    }
    const path = url.pathname.replace(/^\/api\/(admin|agent)/, "");
    if (isAdmin && path === "/projects") {
      if (req.method === "GET") json(projects.list());
      else if (req.method === "POST") {
        const p = projects.create(
          body.name,
          body.summary || "",
          null,
          body.workspace_path || "",
        );
        notify();
        json(p);
      } else throw new AppError("Not found", 404);
      return;
    }
    if (isAdmin && path === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      events.add(res);
      res.write("data: update\n\n");
      const ping = setInterval(() => res.write(": ping\n\n"), 20000);
      req.on("close", () => {
        events.delete(res);
        clearInterval(ping);
      });
      return;
    }
    if (isAgent && !req.headers.authorization)
      throw new AppError("Agent bearer token required", 401);
    const { store, harness, project, workspace, sandbox } = projects.get(
      url.searchParams.get("project"),
    );
    const who = isAgent
      ? store.authenticate(req.headers.authorization?.replace(/^Bearer /, ""))
      : null;
    if (isAgent && !who) throw new AppError("Agent bearer token required", 401);
    if (req.method === "GET" && path === "/state") {
      json(
        who
          ? harness.retrieval.overview(who)
          : {
              ...store.snapshot(),
              ...harness.state(),
              project,
              coding: {
                ...workspace.info(),
                files: [...workspace.list(), ...workspace.unsupported],
                directories: workspace.directories(),
                executions: workspace.runs(),
              },
            },
      );
      return;
    }
    if (req.method === "GET" && path === "/messages") {
      json(
        who
          ? harness.retrieval.readChat(who, {
              chat_id: url.searchParams.get("chat_id"),
              after_message_id: Number(
                url.searchParams.get("after_message_id") || 0,
              ),
              limit: Number(url.searchParams.get("limit") || 10),
            })
          : store.messages(url.searchParams.get("chat_id"), who),
      );
      return;
    }
    if (req.method === "GET" && path === "/files") {
      json(workspace.list());
      return;
    }
    if (req.method === "GET" && path === "/file") {
      if (who) {
        json(
          harness.retrieval.execute(who, {
            type: "read_file",
            path: url.searchParams.get("path"),
            ...(url.searchParams.has("revision")
              ? { revision: Number(url.searchParams.get("revision")) }
              : {}),
            ...(url.searchParams.has("start_line")
              ? { start_line: Number(url.searchParams.get("start_line")) }
              : {}),
            ...(url.searchParams.has("end_line")
              ? { end_line: Number(url.searchParams.get("end_line")) }
              : {}),
          }),
        );
        return;
      }
      json(
        workspace.read(
          url.searchParams.get("path"),
          url.searchParams.has("revision")
            ? Number(url.searchParams.get("revision"))
            : null,
        ),
      );
      return;
    }
    if (req.method === "GET" && path === "/file-history") {
      json(workspace.versions(url.searchParams.get("path")));
      return;
    }
    if (req.method === "GET" && path === "/sandbox") {
      json(await sandbox.status());
      return;
    }
    if (req.method !== "POST") throw new AppError("Not found", 404);
    let result;
    if (path === "/retrieve")
      result = harness.retrieval.execute(who || body.agent_id, body);
    else if (path === "/workspace/open" && !who) {
      const command =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "explorer.exe"
            : "xdg-open";
      await promisify(execFile)(command, [workspace.root], { timeout: 5000 });
      result = { ok: true };
    } else if (path === "/settings" && !who) result = harness.configure(body);
    else if (path === "/agents" && !who)
      result = store.createAgent(body.name, body.prompt);
    else if (path === "/chats")
      result = store.createChat(
        body.name,
        body.kind,
        body.members,
        who,
        body.summary || "",
      );
    else if (path === "/read" && who) {
      if (body.message_ids) {
        if (!Array.isArray(body.message_ids) || body.message_ids.length > 30)
          throw new AppError("message_ids must contain at most 30 IDs");
        store.markSeen(
          who,
          body.message_ids.map((message_id) => ({
            chat_id: body.chat_id,
            message_id,
          })),
        );
        result = { ok: true };
      } else result = store.read(body.chat_id, who, body.through);
    } else if (path === "/chat-details")
      result = store.updateChat(body.chat_id, body.name, body.summary, who);
    else if (path === "/members")
      result = store.addMember(body.chat_id, body.agent_id, who);
    else if (path === "/messages") {
      const message = store.send(body.chat_id, who, body.body);
      result = { ...message, delivery: harness.wake(message) };
    } else if (path === "/respond" && !who) {
      const message = store.get(
        "SELECT * FROM messages WHERE id=?",
        body.message_id,
      );
      if (!message) throw new AppError("Message not found", 404);
      result = harness.wake(message);
    } else if (path === "/directories")
      result = workspace.mkdir(body.path, who);
    else if (path === "/files/sed") result = workspace.sed(body, who);
    else if (path === "/files/write")
      result = workspace.write(
        body.path,
        body.content,
        body.expected_revision,
        who,
      );
    else if (path === "/files/edit")
      result = workspace.edit(
        body.path,
        body.find,
        body.replace,
        body.expected_revision,
        who,
      );
    else if (path === "/environment") {
      if (who)
        throw new AppError(
          "Only the operator can change environment settings",
          403,
        );
      result = workspace.configureEnvironment(body);
    } else if (path === "/uv")
      result = await sandbox.uv(
        body.action,
        body.args || [],
        body.timeout_seconds ?? (body.action === "sync" ? 180 : 20),
        who,
      );
    else if (path === "/python")
      result = await sandbox.run(
        body.path,
        body.args || [],
        body.timeout_seconds ?? 20,
        who,
      );
    else if (path === "/run" && !who)
      result = harness.start(body.ids, body.task, body.maxTurns);
    else if (path === "/stop" && !who) {
      harness.stop();
      result = { ok: true };
    } else throw new AppError("Not found", 404);
    notify();
    json(result);
  } catch (e) {
    json(
      { error: e.status ? e.message : "Internal server error" },
      e.status || 500,
    );
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Relay is running at http://localhost:${port}`),
);
