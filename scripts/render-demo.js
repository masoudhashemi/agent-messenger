import { chromium } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const directory =
  process.argv[2] ||
  readFileSync("/tmp/relay-demo-capture-path", "utf8").trim();
const capture = JSON.parse(
  readFileSync(join(directory, "capture.json"), "utf8"),
);
const out = "docs/media";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  viewport: { width: 1280, height: 120 },
  deviceScaleFactor: 1,
});
const parts = [];
try {
  for (const [i, segment] of capture.segments.entries()) {
    const caption = join(directory, `caption-${i}.png`),
      part = join(directory, `part-${i}.mp4`);
    const title = `${i + 1}. ${segment.label.replace(/^\d+\. /, "")}`;
    await page.setContent(
      '<style>*{box-sizing:border-box}body{margin:0;background:#123b2d;color:white;font-family:Arial,sans-serif;padding:12px 26px}h1{font-size:23px;max-width:1100px;margin:0 0 7px;font-weight:600}p{font-size:17px;max-width:1110px;color:#e0eee7;margin:0;line-height:1.25}.note{position:absolute;bottom:12px;left:26px;font-size:11px;color:#bdd5cb}.brand{position:absolute;right:28px;top:25px;font-size:27px;font-weight:bold;color:#a8dbbd}</style><h1></h1><p id="explanation"></p><div class="note">Real Gemma session · Operator view: you can inspect all chats; agents only see their own conversations.</div><div class="brand">RELAY</div>',
    );
    await page
      .locator("h1")
      .evaluate((el, text) => (el.textContent = text), title);
    await page
      .locator("#explanation")
      .evaluate(
        (el, text) => (el.textContent = text),
        segment.description ||
          "Real agent collaboration; inference waiting time trimmed.",
      );
    await page.screenshot({ path: caption });
    execFileSync(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        String(segment.start),
        "-t",
        String(segment.end - segment.start),
        "-i",
        segment.video || capture.video,
        "-i",
        caption,
        "-filter_complex",
        "[0:v]scale=1280:800,pad=1280:920:0:0:color=0x123b2d[base];[base][1:v]overlay=0:800",
        "-r",
        "20",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-an",
        part,
      ],
      { timeout: 120000 },
    );
    parts.push(part);
  }
} finally {
  await browser.close();
}
const list = join(directory, "concat.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    list,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    join(out, "agent-collaboration.mp4"),
  ],
  { timeout: 120000 },
);
execFileSync(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    join(out, "agent-collaboration.mp4"),
    "-vf",
    "fps=6,scale=1152:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
    "-loop",
    "0",
    join(out, "agent-collaboration.gif"),
  ],
  { timeout: 120000 },
);
writeFileSync(
  join(out, "demo.json"),
  JSON.stringify(
    {
      description:
        "Actual Gemma-generated collaboration: live agent creation followed by a recorded operator tour of group, direct, and self chats. Waiting time removed; explanatory captions added. Machine-specific workspace path hidden.",
      model: "Gemma",
      agents: capture.agents.map((a) => a.name),
      new_agents: capture.created?.length || 0,
      turns: capture.turns,
      status: capture.status,
      executions: capture.executions,
      chapters: capture.segments.map((s) => ({
        title: s.label.replace(/^\d+\. /, ""),
        explanation: s.description || "",
      })),
    },
    null,
    2,
  ) + "\n",
);
console.log("Rendered docs/media/agent-collaboration.mp4 and .gif");
