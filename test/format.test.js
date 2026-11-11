import test from "node:test";
import assert from "node:assert/strict";
import { renderMessage, markdown, preview } from "../public/format.js";
test("messages format notes, markdown and checklists while escaping HTML", () => {
  const html = renderMessage(
    "Turn 2 · Working note\n**Plan**\n- [x] Done\n- [ ] Next\n`<script>alert(1)</script>`\n<img src=x onerror=alert(1)>",
  );
  assert.match(html, /entry-label/);
  assert.match(html, /<strong>Plan<\/strong>/);
  assert.match(html, /☑/);
  assert.match(html, /☐/);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
  assert.match(markdown("```js\na < b\n```"), /<pre><code>a &lt; b/);
});
test("self action results show readable summaries and escaped expandable details", () => {
  const body =
    "Turn 1 · Action results\n" +
    JSON.stringify([
      {
        action: "direct",
        result: { chat_id: "dm", body: "**Hello** <script>bad</script>" },
      },
      { action: "finish", result: { status: "finished" } },
    ]);
  const html = renderMessage(body, [{ id: "dm", name: "Atlas & Nova" }], "42");
  assert.match(html, /Message sent/);
  assert.match(html, /Atlas &amp; Nova/);
  assert.match(html, /Finished this task/);
  assert.match(html, /<details class="raw-result" data-audit="42">/);
  assert.ok(!html.includes("<script>"));
  assert.equal(preview(body), "Turn 1 · 2 actions recorded");
});
test("malformed audit data remains readable and cannot inject HTML", () => {
  const html = renderMessage("Turn 2 · Action results\n[<svg onload=alert(1)>");
  assert.ok(!html.includes("<svg"));
  assert.match(html, /&lt;svg/);
});

test("execution labels escape model-provided status text", () => {
  const body =
    "Turn 1 · Action results\n" +
    JSON.stringify([
      {
        action: "run_python",
        result: { path: "test.py", status: "<img src=x onerror=alert(1)>" },
      },
    ]);
  const html = renderMessage(body);
  assert.ok(!html.includes("<img"));
  assert.match(html, /&lt;img/);
});
