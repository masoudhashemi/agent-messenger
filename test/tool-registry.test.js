import test from "node:test";
import assert from "node:assert/strict";
import { tools, toolCatalog, toolInstructions } from "../src/tools/index.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { renderMessage } from "../public/format.js";

test("a registered tool appears in catalog, permissions, prompt and execution without dedicated harness code", async () => {
  const definition = {
    name: "word_count",
    label: "Word count",
    description: "Count words",
    example: { type: "word_count", text: "hello world" },
    execute: async (_, action) => ({
      words: action.text.trim().split(/\s+/).length,
    }),
  };
  tools.set(definition.name, definition);
  const s = new Store();
  try {
    const a = s.createAgent("Writer", "Write", ["word_count"]);
    assert.ok(
      toolCatalog({
        webSearch: { status: () => ({ configured: false }) },
      }).some((t) => t.name === "word_count" && t.status.configured),
    );
    assert.match(
      toolInstructions(a.tools, {
        webSearch: { status: () => ({ configured: false }) },
      }),
      /word_count/,
    );
    assert.ok(
      !toolInstructions([], {
        webSearch: { status: () => ({ configured: false }) },
      }).includes("Count words"),
    );
    let turn = 0;
    const h = new Harness(
      s,
      () => {},
      async () =>
        JSON.stringify({
          working_note: { name: "Work", body: "Count words" },
          actions:
            ++turn === 1
              ? [
                  { type: "word_count", text: "hello world" },
                  { type: "finish" },
                ]
              : [{ type: "finish" }],
        }),
    );
    h.start([a.id], "Count two words", 3);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(turn, 2);
    const message = s
      .snapshot(a.id)
      .chats.flatMap((c) => c.messages)
      .find((m) => m.body.startsWith("Tool result\n"));
    assert.equal(JSON.parse(message.body.slice(12)).words, 2);
    assert.match(renderMessage(message.body), /word_count/);
    s.setAgentTools(a.id, []);
    turn = 0;
    h.start([a.id], "Count again", 2);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.ok(h.history.some((e) => e.message?.includes("not enabled")));
  } finally {
    s.db.close();
    tools.delete(definition.name);
  }
});
