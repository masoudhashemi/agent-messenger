import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "relay-demo-"));
const port = 3322,
  base = `http://localhost:${port}`;
const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    PROJECTS_DIR: join(directory, "projects"),
  },
  stdio: "ignore",
});
let browser, context, video, started;
const segments = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(base);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  browser = await chromium.launch({ channel: "chrome", headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: {
      dir: join(directory, "video"),
      size: { width: 1440, height: 900 },
    },
  });
  const page = await context.newPage();
  video = page.video();
  started = Date.now();
  await page.goto(base);
  const api = (path, body, project) =>
    page.evaluate(
      async ({ path, body, project }) => {
        const r = await fetch(
          "/api/admin/" + path + (project ? "?project=" + project : ""),
          {
            method: body ? "POST" : "GET",
            headers: { "Content-Type": "application/json" },
            body: body ? JSON.stringify(body) : undefined,
          },
        );
        const data = await r.json();
        if (!r.ok) throw Error(JSON.stringify(data));
        return data;
      },
      { path, body, project },
    );
  const p = await api("projects", {
    name: "From one agent to a team",
    summary:
      "A real Gemma demonstration: create a specialist, collaborate privately, and verify Python code.",
  });
  const lead = await api(
    "agents",
    {
      name: "Atlas · Builder",
      prompt:
        "You are Atlas, a Python builder coordinating this small project. Implement a clamp(value, low, high) function in clamp.py; low > high must raise ValueError. You are initially the only agent. Independent verification is required: if the directory has no tester, create ONE teammate named Nova · Tester with a focused system prompt and a task to read clamp.py, write test_clamp.py using unittest for below/in/above range and invalid bounds, run it in Docker, and report the exact result to you by direct message. You may create an agent because the operator enabled that capability. Do not test your own code instead of independent review. After creating the tester, use its returned ID to create a group named Release room with both of you, sharing the acceptance criteria. When awaiting its report, finish your current work so its direct message can wake you. Once the tester confirms passing tests, reply to it by direct message and post a concise final release report in Release room. Use concise messages and private working notes. Do not create duplicate agents or groups. No extra features.",
    },
    p.id,
  );
  await page.goto(base + "/?project=" + p.id);
  await page.locator("#allow-agent-creation").check();
  await page.waitForFunction(async () => {
    const s = await (await fetch("/api/admin/state" + location.search)).json();
    return s.settings.allow_agent_creation;
  });
  await page
    .locator("#task")
    .fill(
      "Build clamp(value, low, high), obtain independent tests from a specialist, and share the verified result with the team. Create a teammate if the required role is missing.",
    );
  await page.locator("#turns").fill("16");
  const hold = async (label, seconds = 4) => {
    const start = (Date.now() - started) / 1000;
    await page.waitForTimeout(seconds * 1000);
    segments.push({ start, end: (Date.now() - started) / 1000, label });
    console.log(label);
  };
  await hold("1. Start with one agent; allow the team to grow", 5);
  await page.locator("#run").hover();
  await api(
    "run",
    {
      ids: [lead.id],
      task: "Build clamp(value, low, high), obtain independent tests from a specialist, and share the verified result with the team. Create a teammate if the required role is missing.",
      maxTurns: 16,
    },
    p.id,
  );
  let showedCreation = false,
    showedDM = false,
    showedGroup = false,
    showedNotes = false,
    state;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    state = await api("state", null, p.id);
    if (!showedCreation && state.agents.length > 1) {
      const dm = state.chats.find((c) => c.kind === "direct");
      if (dm) await page.locator(`[data-chat="${dm.id}"]`).click();
      await hold("2. Atlas creates Nova, an independent tester", 7);
      showedCreation = true;
    }
    const dm = state.chats.find(
      (c) =>
        c.kind === "direct" &&
        c.messages.some((m) => m.sender_id && m.sender_id !== lead.id),
    );
    if (!showedDM && dm) {
      await page.locator(`[data-chat="${dm.id}"]`).click();
      await hold("3. Agents exchange private messages and test results", 7);
      showedDM = true;
    }
    const group = state.chats.find((c) => c.kind === "group");
    if (
      !showedGroup &&
      group &&
      state.coding.executions.some((e) => e.status === "succeeded")
    ) {
      await page.locator(`[data-chat="${group.id}"]`).click();
      await hold("4. A group chat keeps the team aligned", 6);
      showedGroup = true;
    }
    if (state.run?.status !== "running") break;
    await page.waitForTimeout(700);
  }
  if (state.run?.status === "running") throw Error("Demo timed out");
  if (
    !showedCreation ||
    !showedDM ||
    !state.coding.executions.some((e) => e.status === "succeeded")
  )
    throw Error(
      "Demo did not demonstrate creation, collaboration and successful execution",
    );
  const group = state.chats.find((c) => c.kind === "group");
  if (group) {
    await page.locator(`[data-chat="${group.id}"]`).click();
    await hold("5. Verified results are shared with the group", 6);
  }
  const notes = state.chats.find(
    (c) => c.kind === "self" && c.members.includes(lead.id),
  );
  if (notes) {
    await page.locator(`[data-chat="${notes.id}"]`).click();
    await hold("6. Each agent keeps its own private working notes", 5);
    showedNotes = true;
  }
  await page.locator("#code-workspace").click();
  await page.locator('[data-file="clamp.py"]').click();
  // This read-only demonstration omits the machine-specific workspace location.
  await page.locator(".workspace-location").evaluate((el) => {
    el.style.display = "none";
  });
  await page.locator(".environment-panel").evaluate((el) => {
    el.style.display = "none";
  });
  await hold("7. Shared files, Git authorship, and real Docker tests", 7);
  await context.close();
  context = null;
  const videoPath = await video.path();
  const report = {
    video: videoPath,
    segments,
    project_id: p.id,
    agents: state.agents.map((a) => ({ name: a.name, id: a.id })),
    created: state.run.created_agents,
    turns: state.run.turns,
    status: state.run.status,
    executions: state.coding.executions.map((e) => ({
      path: e.path,
      status: e.status,
      stdout: e.stdout,
      stderr: e.stderr,
    })),
    notes: showedNotes,
  };
  writeFileSync(
    join(directory, "capture.json"),
    JSON.stringify(report, null, 2),
  );
  writeFileSync("/tmp/relay-demo-capture-path", directory);
  console.log(
    JSON.stringify({
      capture: directory,
      status: report.status,
      turns: report.turns,
      agents: report.agents.map((a) => a.name),
    }),
  );
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  const exited = once(server, "exit");
  server.kill();
  await exited;
}
