import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source =
  process.argv[2] ||
  readFileSync("/tmp/relay-demo-capture-path", "utf8").trim();
const original = JSON.parse(readFileSync(join(source, "capture.json"), "utf8"));
const projectDirectory = original.project_directory || join(source, "projects");
const directory = mkdtempSync(join(tmpdir(), "relay-demo-tour-"));
const base = "http://localhost:3322";
const server = spawn(process.execPath, ["src/server.js"], {
  env: { ...process.env, PORT: "3322", PROJECTS_DIR: projectDirectory },
  stdio: "ignore",
});
let browser, context;
const tour = [];
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
  const page = await context.newPage(),
    video = page.video(),
    started = Date.now();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base + "/?project=" + original.project_id);
  await page.locator('[data-filter="group"]').waitFor();
  const state = await page.evaluate(
    async () =>
      await (await fetch("/api/admin/state" + location.search)).json(),
  );
  const group = state.chats.find((c) => c.kind === "group"),
    direct = state.chats.find((c) => c.kind === "direct");
  const atlas = state.agents.find((a) => a.name.startsWith("Atlas")),
    nova = state.agents.find((a) => a.id !== atlas.id);
  const atlasNotes = state.chats.find(
    (c) => c.kind === "self" && c.members.includes(atlas.id),
  );
  const novaNotes = state.chats.find(
    (c) => c.kind === "self" && c.members.includes(nova.id),
  );
  if (!group || !direct || !atlasNotes || !novaNotes)
    throw Error(
      "The source demo must contain group, direct, and both self chats",
    );
  async function chapter(label, description, seconds, action) {
    const start = (Date.now() - started) / 1000;
    await action();
    await page.waitForTimeout(seconds * 1000);
    tour.push({
      start,
      end: (Date.now() - started) / 1000,
      label,
      description,
    });
    console.log(label);
  }
  async function select(kind, chat) {
    const tab = page.locator(`[data-filter="${kind}"]`);
    await tab.hover();
    await page.waitForTimeout(600);
    await tab.click();
    await page.waitForTimeout(650);
    await page.locator(`[data-chat="${chat.id}"]`).hover();
    await page.waitForTimeout(400);
    await page.locator(`[data-chat="${chat.id}"]`).click();
    await page.waitForTimeout(300);
  }
  await chapter(
    "Group chats: collaborate with selected teammates",
    "Only invited group members can read the shared discussion.",
    7,
    () => select("group", group),
  );
  await chapter(
    "Direct chats: a private one-to-one conversation",
    "Exactly two agents exchange requests, feedback and test results.",
    7,
    () => select("direct", direct),
  );
  await chapter(
    "Self chats: one agent’s private working space",
    "Plans, observations and tool results. Each agent can keep several named self chats.",
    8,
    async () => {
      await select("self", atlasNotes);
      await page
        .locator(".messages")
        .evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
    },
  );
  await chapter(
    "Separate self chats for each agent",
    "Nova’s notes belong to Nova. Atlas cannot read them, and Nova cannot read Atlas’s notes.",
    7,
    async () => {
      await page.locator(`[data-chat="${novaNotes.id}"]`).hover();
      await page.waitForTimeout(700);
      await page.locator(`[data-chat="${novaNotes.id}"]`).click();
      await page
        .locator(".messages")
        .evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" }));
    },
  );
  await chapter(
    "Back to the group: share the verified outcome",
    "Private conversations stay private; an agent chooses what to report to the group.",
    6,
    () => select("group", group),
  );
  await chapter(
    "Shared files, Git authorship and Docker tests",
    "Both agents work on the project files. Nova’s four independent tests passed.",
    7,
    async () => {
      await page.locator("#code-workspace").click();
      await page.locator('[data-file="clamp.py"]').click();
      await page.waitForFunction(() =>
        document.querySelector("#code-content")?.value.includes("def clamp"),
      );
      await page
        .locator(".workspace-location")
        .evaluate((el) => (el.style.display = "none"));
      await page
        .locator(".environment-panel")
        .evaluate((el) => (el.style.display = "none"));
      await page.locator(".execution summary").first().click();
    },
  );
  if (errors.length) throw Error(errors.join("; "));
  await context.close();
  context = null;
  const tourVideo = await video.path();
  const intro = original.segments
    .slice(0, 2)
    .map((s, i) => ({
      ...s,
      video: s.video || original.video,
      description:
        i === 0
          ? "Enable bounded teammate creation when a specialist role is missing."
          : "Atlas creates Nova with its own role and task; Nova joins the same run.",
    }));
  const capture = {
    ...original,
    video: tourVideo,
    project_directory: projectDirectory,
    segments: [...intro, ...tour.map((s) => ({ ...s, video: tourVideo }))],
    review: true,
  };
  writeFileSync(
    join(directory, "capture.json"),
    JSON.stringify(capture, null, 2),
  );
  writeFileSync("/tmp/relay-demo-capture-path", directory);
  console.log(
    JSON.stringify({
      capture: directory,
      chapters: capture.segments.length,
      seconds: capture.segments.reduce((n, s) => n + s.end - s.start, 0),
    }),
  );
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  const exited = once(server, "exit");
  server.kill();
  await exited;
}
