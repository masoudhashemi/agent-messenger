import { lineDiff } from "./diff.js";
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function inline(text) {
  // Escape before formatting; model-provided HTML never becomes executable markup.
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`")
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part).replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"),
    )
    .join("");
}
export function markdown(text) {
  const lines = String(text).split("\n");
  let html = "",
    paragraph = [],
    list = null,
    code = null;
  const flush = () => {
    if (paragraph.length) {
      html += `<p>${paragraph.map(inline).join("<br>")}</p>`;
      paragraph = [];
    }
    if (list) {
      html += `</${list}>`;
      list = null;
    }
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flush();
      if (code !== null) {
        html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
        code = null;
      } else code = [];
      continue;
    }
    if (code !== null) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/);
    if (heading) {
      flush();
      html += `<h3>${inline(heading[1])}</h3>`;
      continue;
    }
    const item = line.match(/^\s*(?:[-*+]\s+|(\d+)\.\s+)(.*)$/);
    if (item) {
      const tag = item[1] ? "ol" : "ul";
      if (list !== tag) {
        flush();
        list = tag;
        html += `<${tag}>`;
      }
      const check = item[2].match(/^\[([ xX])\]\s+(.*)/);
      html += check
        ? `<li class="check-item"><span aria-label="${check[1] === " " ? "Incomplete" : "Complete"}">${check[1] === " " ? "☐" : "☑"}</span> ${inline(check[2])}</li>`
        : `<li>${inline(item[2])}</li>`;
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();
  if (code !== null)
    html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
  return html;
}
function audit(body) {
  const match = body.match(
    /^(Turn \d+) · Action results(?: \(continued\))?\n([\s\S]*)$/,
  );
  if (!match) return null;
  try {
    const items = JSON.parse(match[2]);
    return Array.isArray(items)
      ? { title: match[1], items, raw: match[2] }
      : null;
  } catch {
    return null;
  }
}
function fileNotice(body) {
  if (!body.startsWith("File change\n")) return null;
  try {
    const ref = JSON.parse(body.slice(12));
    return typeof ref.path === "string" &&
      Number.isInteger(ref.revision) &&
      ref.revision > 0
      ? ref
      : null;
  } catch {
    return null;
  }
}
export function fileDiffCard(ref) {
  if (
    typeof ref.path !== "string" ||
    !Number.isInteger(ref.revision) ||
    ref.revision < 1
  )
    return "";
  return `<section class="chat-file-diff" data-diff-path="${escapeHtml(ref.path)}" data-diff-revision="${ref.revision}"><header><strong>${escapeHtml(ref.path)}</strong><span>v${ref.revision - 1} → v${ref.revision}</span><button class="quiet" data-open-diff>Open full diff ↗</button></header><div class="chat-diff-content"><p class="muted">Loading diff…</p></div></section>`;
}
export function renderDiffPreview(before, after) {
  const rows = lineDiff(before, after),
    visible = new Set();
  let added = 0,
    removed = 0;
  rows.forEach((row, i) => {
    if (row.type === "same") return;
    if (row.type === "added") added++;
    else removed++;
    for (let j = Math.max(0, i - 2); j <= Math.min(rows.length - 1, i + 2); j++)
      visible.add(j);
  });
  const indices = [...visible].sort((a, b) => a - b),
    shown = indices.slice(0, 80);
  let last = -1;
  const html = shown
    .map((i) => {
      const row = rows[i],
        gap = i > last + 1 ? '<div class="diff-gap">…</div>' : "";
      last = i;
      return (
        gap +
        `<div class="diff-line ${row.type}"><span class="line-number">${row.oldLine ?? ""}</span><span class="line-number">${row.newLine ?? ""}</span><span class="diff-sign">${row.type === "added" ? "+" : row.type === "removed" ? "−" : " "}</span><code>${escapeHtml(row.text.replace(/\n$/, ""))}${!row.text.endsWith("\n") ? '<span class="no-newline"> ↵ no trailing newline</span>' : ""}</code></div>`
      );
    })
    .join("");
  return `<div class="chat-diff-summary">+${added} / −${removed} lines</div><div class="chat-diff-lines">${html || '<p class="muted">No text changes (empty file or metadata change).</p>'}</div>${indices.length > shown.length ? '<p class="muted">Preview limited to 80 lines. Open the full diff to see all changes.</p>' : ""}`;
}
function webSearchNotice(body) {
  if (!body.startsWith("Web search\n")) return null;
  try {
    const result = JSON.parse(body.slice(11));
    return typeof result.query === "string" && Array.isArray(result.results)
      ? result
      : null;
  } catch {
    return null;
  }
}
function renderSearch(result) {
  return `<section class="web-search-result"><div class="entry-label">Web search · ${escapeHtml(result.provider)}</div><strong>${escapeHtml(result.query)}</strong>${
    result.results
      .map((r) => {
        let url;
        try {
          url = new URL(r.url);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            return "";
        } catch {
          return "";
        }
        return `<article><a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title || url.hostname)} ↗</a><small>${escapeHtml(url.hostname)}</small><p>${escapeHtml(r.snippet)}</p></article>`;
      })
      .join("") || '<p class="muted">No results found.</p>'
  }<small class="muted">Search snippets · ${escapeHtml(result.searched_at || "")}</small></section>`;
}
export function preview(body) {
  const search = webSearchNotice(body);
  if (search) return "Web search · " + search.query;
  const ref = fileNotice(body);
  if (ref) return `File changed · ${ref.path} · v${ref.revision}`;
  const parsed = audit(body);
  if (parsed)
    return `${parsed.title} · ${parsed.items.length} action${parsed.items.length === 1 ? "" : "s"} recorded`;
  return body.replace(/^Turn \d+ · Working note\n/, "").replace(/\s+/g, " ");
}
export function artifactButton(id, label = "View complete output") {
  return id
    ? `<button class="quiet" data-artifact="${escapeHtml(id)}">${escapeHtml(label)} ↗</button>`
    : "";
}
export function renderMessage(body, chats = [], id = "") {
  if (body.startsWith("Tool result\n")) {
    try {
      const result = JSON.parse(body.slice(12));
      return `<div class="entry-label">Tool result · ${escapeHtml(result.tool)}</div><pre><code>${escapeHtml(JSON.stringify(result, null, 2))}</code></pre>${artifactButton(result.artifact_id)}`;
    } catch {}
  }
  const search = webSearchNotice(body);
  if (search) return renderSearch(search) + artifactButton(search.artifact_id);
  const ref = fileNotice(body);
  if (ref) return fileDiffCard(ref);
  const parsed = audit(body);
  if (parsed) {
    return `<div class="entry-label">${escapeHtml(parsed.title)} · Action results</div><div class="action-list">${
      parsed.items
        .map((item) => {
          if (!item || typeof item !== "object")
            return '<div class="action-item">Result recorded</div>';
          const r = item.result || {},
            chat = chats.find((c) => c.id === (r.chat_id || r.id));
          const label =
            r.path && item.action === "run_python"
              ? "Python · " + r.status
              : r.path &&
                  ["read_file", "write_file", "edit_file"].includes(item.action)
                ? item.action === "read_file"
                  ? "File read"
                  : "File saved"
                : r.error
                  ? "Action failed"
                  : r.status === "finished"
                    ? "Finished this task"
                    : r.body
                      ? "Message sent"
                      : item.action === "update_chat"
                        ? "Thread updated"
                        : item.action === "invite"
                          ? "Member added"
                          : r.kind === "self"
                            ? "Self-thread ready"
                            : r.kind === "group"
                              ? "Group ready"
                              : "Action completed";
          return `<div class="action-item ${r.error ? "action-error" : ""}"><span class="action-check">${r.error ? "!" : "✓"}</span><div><strong>${escapeHtml(label)}</strong>${r.path ? `<span class="action-target">${escapeHtml(r.path)}${r.revision ? ` · v${r.revision}` : ""}</span>` : ""}${item.action === "run_python" ? `<div class="execution-output">${r.stdout ? `<pre><code>${escapeHtml(r.stdout)}</code></pre>` : ""}${r.stderr ? `<pre><code>${escapeHtml(r.stderr)}</code></pre>` : ""}<small>Exit ${escapeHtml(r.exit_code ?? "—")} · ${escapeHtml(r.duration_ms)} ms</small></div>` : ""}${chat || r.name ? `<span class="action-target">${escapeHtml(chat?.name || r.name)}</span>` : ""}${r.error ? `<p>${escapeHtml(r.error)}</p>` : ""}${r.body ? `<div class="action-body">${markdown(r.body)}</div>` : ""}${artifactButton(r.artifact_id)}${!r.diff_posted && !r.error && ["write_file", "edit_file", "sed"].includes(item.action) ? fileDiffCard(r) : ""}${
            !r.diff_posted && Array.isArray(r.changes)
              ? r.changes
                  .flatMap((e) => e.changes || [])
                  .map(fileDiffCard)
                  .join("")
              : ""
          }</div></div>`;
        })
        .join("") || '<p class="muted">No actions · Working note saved.</p>'
    }</div><details class="raw-result" data-audit="${escapeHtml(id)}"><summary>Raw action data</summary><pre><code>${escapeHtml(parsed.raw)}</code></pre></details>`;
  }
  const note = body.match(
    /^(Turn \d+) · (Working note|Error|Action results \(continued\))\n([\s\S]*)$/,
  );
  if (note)
    return `<div class="entry-label">${escapeHtml(note[1])} · ${escapeHtml(note[2])}</div>${note[2].startsWith("Action results") ? `<pre><code>${escapeHtml(note[3])}</code></pre>` : markdown(note[3])}`;
  return markdown(body);
}
