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
export function preview(body) {
  const parsed = audit(body);
  if (parsed)
    return `${parsed.title} · ${parsed.items.length} action${parsed.items.length === 1 ? "" : "s"} recorded`;
  return body.replace(/^Turn \d+ · Working note\n/, "").replace(/\s+/g, " ");
}
export function renderMessage(body, chats = [], id = "") {
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
          return `<div class="action-item ${r.error ? "action-error" : ""}"><span class="action-check">${r.error ? "!" : "✓"}</span><div><strong>${escapeHtml(label)}</strong>${r.path ? `<span class="action-target">${escapeHtml(r.path)}${r.revision ? ` · v${r.revision}` : ""}</span>` : ""}${item.action === "run_python" ? `<div class="execution-output">${r.stdout ? `<pre><code>${escapeHtml(r.stdout)}</code></pre>` : ""}${r.stderr ? `<pre><code>${escapeHtml(r.stderr)}</code></pre>` : ""}<small>Exit ${escapeHtml(r.exit_code ?? "—")} · ${escapeHtml(r.duration_ms)} ms</small></div>` : ""}${chat || r.name ? `<span class="action-target">${escapeHtml(chat?.name || r.name)}</span>` : ""}${r.error ? `<p>${escapeHtml(r.error)}</p>` : ""}${r.body ? `<div class="action-body">${markdown(r.body)}</div>` : ""}</div></div>`;
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
