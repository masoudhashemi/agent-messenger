import test from "node:test";
import assert from "node:assert/strict";
import { lineDiff } from "../public/diff.js";
function reconstruct(rows, type) {
  return rows
    .filter((r) => r.type !== type)
    .map((r) => r.text)
    .join("");
}
test("diff preserves exact source, line numbers and trailing-newline changes", () => {
  for (const [before, after] of [
    ["", "first\n"],
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["x", "x\n"],
    ["a\na\n", "a\n"],
    ["a\n", ""],
    ["same", "same"],
  ]) {
    const rows = lineDiff(before, after);
    assert.equal(reconstruct(rows, "added"), before);
    assert.equal(reconstruct(rows, "removed"), after);
    assert.deepEqual(
      rows.filter((r) => r.oldLine).map((r) => r.oldLine),
      Array.from(
        { length: rows.filter((r) => r.oldLine).length },
        (_, i) => i + 1,
      ),
    );
  }
  const rows = lineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(rows.filter((r) => r.type === "added").length, 1);
  assert.equal(rows.filter((r) => r.type === "removed").length, 1);
});
test("large diffs stay bounded and reconstruct both versions", () => {
  const a = "old\n".repeat(1100),
    b = "new\n".repeat(1100);
  const rows = lineDiff(a, b);
  assert.equal(reconstruct(rows, "added"), a);
  assert.equal(reconstruct(rows, "removed"), b);
});
