import { pluginUI } from "./plugins.js";
import { commandArguments } from "./commands.js";
import { lineDiff } from "/diff.js";
import { renderMessage, preview, renderDiffPreview } from "/format.js";
const projectId = new URLSearchParams(location.search).get("project");
let state = { agents: [], chats: [], history: [] },
  selected = null,
  filter = "all",
  query = "",
  drafts = {};
const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const name = (id) => state.agents.find((a) => a.id === id)?.name || "Operator";
const initials = (s) =>
  s
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const time = (s) =>
  new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
async function api(path, body, scope = projectId) {
  const r = await fetch(
    "/api/admin/" +
      path +
      (scope && path !== "projects"
        ? (path.includes("?") ? "&" : "?") +
          "project=" +
          encodeURIComponent(scope)
        : ""),
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const d = await r.json();
  if (!r.ok) throw Error(d.error);
  return d;
}
function toast(s) {
  $("#toast").textContent = s;
  $("#toast").style.display = "block";
  setTimeout(() => ($("#toast").style.display = "none"), 5000);
}
async function refresh() {
  try {
    if (!projectId) {
      renderHome(await api("projects"));
      return;
    }
    state = await api("state");
    if (!selected && state.chats.length)
      selected =
        state.chats.find((c) => c.kind === "group")?.id || state.chats[0].id;
    render();
    if ($("#modal").open && $("#code-files")) updateCodePanels();
  } catch (e) {
    toast(e.message);
  }
}
function renderHome(projects) {
  $("#app").innerHTML =
    `<div class="project-home"><header class="home-nav"><span class="home-brand">r.</span><span>RELAY <small>/ AGENT WORKSPACES</small></span><span class="home-local"><i class="dot"></i>Local workspace</span></header><main class="home-content"><div class="home-heading"><div><div class="eyebrow">Your agent workspaces</div><h1>Ideas in motion.</h1><p>Pick up where your agents left off, or give them something new to explore.</p></div><button class="primary" id="new-project">＋ New project</button></div><div class="section-head"><h2>All projects <small>${projects.length}</small></h2><span class="muted">Separate teams. Persistent conversations.</span></div><div class="project-grid">${projects.map((p) => `<article class="project-card"><div class="heading"><div class="avatar">${esc(initials(p.name))}</div><span class="state ${p.run?.status === "running" ? "running" : ""}">${esc(p.run?.status?.replaceAll("_", " ") || "Ready to start")}</span></div><h2>${esc(p.name)}</h2><p class="project-summary">${esc(p.summary || "A fresh workspace for your agents.")}</p><p class="project-path" title="${esc(p.workspace_path || "")}">${esc(p.workspace_path || "")}</p><div class="project-counts"><span><strong>${p.agents}</strong> agents</span><span><strong>${p.chats}</strong> threads</span><span><strong>${p.messages}</strong> messages</span></div><p class="muted">${p.run ? `Last objective: ${esc(p.run.task.slice(0, 140))}` : "No runs yet. Add agents and set an objective."}</p><div class="project-card-footer"><button class="quiet delete-project" data-delete-project="${p.id}" aria-label="Delete ${esc(p.name)}">Delete</button><a class="review-link" href="/?project=${p.id}">Review ↗</a><button class="${p.run?.task ? "primary" : ""}" data-resume="${p.id}">${p.run?.status === "running" ? "Open live" : p.run?.task ? "Resume" : "Open project"} →</button></div></article>`).join("") || '<div class="home-empty"><div class="avatar">＋</div><h2>Your next project starts here.</h2><p>Create a project, add agents, and let conversations grow as they work.</p></div>'}</div><p class="home-footnote">Each project has its own agents, private notes, and conversation history. New projects start empty.</p></main></div>`;
  document.querySelectorAll("[data-delete-project]").forEach((button) => {
    button.onclick = () => {
      const project = projects.find(
        (p) => p.id === button.dataset.deleteProject,
      );
      modal(
        `<h2>Delete ${esc(project.name)}?</h2><p>This permanently deletes the project's agents, chats, tasks, and execution records. This cannot be undone.</p><label class="check"><input type="checkbox" name="delete_artifacts"> Also delete all project files and artifacts</label><p class="muted">Includes the workspace folder below, its Python environment, Git history, and package cache. Leave unchecked to keep these on disk.</p><p class="delete-workspace-path">${esc(project.workspace_path)}</p><label>Type <strong>${esc(project.name)}</strong> to confirm</label><input name="confirm_name" required autocomplete="off">`,
        async (form, dialog) => {
          await api(
            "projects/delete",
            {
              id: project.id,
              confirm_name: form.get("confirm_name"),
              delete_artifacts: form.has("delete_artifacts"),
            },
            null,
          );
          dialog.close();
          await refresh();
          toast(
            form.has("delete_artifacts")
              ? "Project and artifacts deleted"
              : "Project deleted. Workspace files and Git history kept on disk.",
          );
        },
      );
      const save = $("#modal-form button.primary");
      save.textContent = "Delete project";
      save.classList.add("danger");
    };
  });
  $("#new-project").onclick = () =>
    modal(
      '<h2>New project</h2><p class="muted">Start with an empty workspace. Add agents and let them build their own conversations.</p><label>Name</label><input name="name" maxlength="100" required placeholder="e.g. Research assistant team"><label>Project folder (optional)</label><input name="workspace_path" placeholder="/Users/you/Projects/my-project"><p class="muted">Choose a new or empty folder. Leave blank to create one automatically.</p><label>Short description</label><textarea name="summary" maxlength="1000" rows="3" placeholder="What is this project for?"></textarea>',
      async (f, d) => {
        const p = await api("projects", Object.fromEntries(f));
        d.close();
        location.href = "/?project=" + p.id;
      },
    );
  document.querySelectorAll("[data-resume]").forEach(
    (button) =>
      (button.onclick = () =>
        act(async () => {
          button.disabled = true;
          try {
            const p = projects.find((p) => p.id === button.dataset.resume);
            if (p.run?.task && p.run.status !== "running") {
              const current = await api("state", undefined, p.id);
              await api(
                "run",
                {
                  ids: current.agents.map((a) => a.id),
                  task: p.run.task,
                  maxTurns: p.run.maxTurns,
                },
                p.id,
              );
            }
            location.href = "/?project=" + p.id;
          } finally {
            button.disabled = false;
          }
        })),
  );
}
function deliveryStatus(message, chat) {
  if (message.sender_id) return "";
  const request = state.requests?.find((r) => r.message_id === message.id);
  const label =
    request?.status === "queued"
      ? "Queued for agents"
      : request?.status === "delivered"
        ? "Delivered to agents"
        : request?.status === "cancelled"
          ? "Agent response stopped"
          : request?.status === "error"
            ? "Could not process request"
            : chat.read_states.every((r) => r.last_read_id >= message.id)
              ? "Read by agents"
              : "Not yet scheduled";
  const retry = !request || ["error", "cancelled"].includes(request.status);
  return `<div class="delivery-status ${request?.status === "error" ? "delivery-error" : ""}"><span>${esc(label)}</span>${request?.error ? `<span>${esc(request.error)}</span>` : ""}${retry ? `<button class="quiet" data-respond="${message.id}">${request ? "Retry" : "Ask agents to respond"}</button>` : ""}</div>`;
}
const icon = (c) =>
  c.kind === "group" ? "#" : c.kind === "self" ? "↳" : initials(c.name);
function render() {
  const openAudits = [
    ...document.querySelectorAll("details[data-audit][open]"),
  ].map((el) => el.dataset.audit);
  const focus = document.activeElement?.id,
    sel = document.activeElement?.selectionStart;
  const oldScroll = $(".messages"),
    atBottom =
      !oldScroll ||
      oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight <
        80,
    scroll = oldScroll?.scrollTop || 0;
  const task = $("#task")?.value,
    turns = $("#turns")?.value;
  const c = state.chats.find((c) => c.id === selected),
    running = state.run?.status === "running";
  $("#app").innerHTML =
    `<div class="layout"><nav class="rail"><div class="brand">r.</div><div class="rail-icon">☷</div><div title="Private agent workspace">◈</div><div class="rail-bottom">RELAY / WORKSPACE</div></nav><aside class="sidebar"><div class="sidebar-top"><div class="heading"><h1>Conversations</h1><button class="quiet" id="new-chat" title="New conversation">＋</button></div><p class="subtitle"><a href="/">← Projects</a> / ${esc(state.project?.name || "Workspace")}</p><button class="quiet" id="sidebar-add-agent">＋ Add agent</button><input id="search" class="search" placeholder="Search conversations…" value="${esc(query)}"><div class="tabs">${[
      ["all", "All"],
      ["group", "Groups"],
      ["direct", "Direct"],
      ["self", "Self"],
    ]
      .map(
        ([v, l]) =>
          `<button data-filter="${v}" class="${filter === v ? "active" : ""}">${l}</button>`,
      )
      .join("")}</div></div><div class="chat-list">${
      state.chats
        .filter(
          (c) =>
            (filter === "all" || c.kind === filter) &&
            `${c.name} ${c.summary}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .map(
          (c) =>
            `<button class="chat-row ${selected === c.id ? "selected" : ""}" data-chat="${c.id}"><div class="avatar ${c.kind}">${esc(icon(c))}</div><div class="row-copy"><div class="row-title"><span>${esc(c.name)}</span></div><div class="row-preview">${esc(preview(c.messages.at(-1)?.body || c.summary || "No messages yet"))}</div><div class="row-preview">${c.kind === "self" ? "Personal workspace" : c.members.length + " members"} · ${c.messages.length} messages</div></div></button>`,
        )
        .join("") ||
      '<p class="muted" style="padding:12px">Your conversations will appear here.</p>'
    }</div><div class="sidebar-foot"><button id="manage-plugins" class="quiet">⊞ Tools & plugins</button><button id="search-knowledge" class="quiet" title="Search accessible messages, source and executions">⌕ Search</button><button id="code-workspace" class="quiet">⌘ Code workspace <small>${state.coding?.files.length || 0}</small></button></div></aside><main class="main">${c ? `<header class="chat-head"><div class="avatar ${c.kind}">${esc(icon(c))}</div><div><h2>${esc(c.name)}</h2><p>${esc(c.members.map(name).join(", "))}</p></div><span class="badge">${c.kind === "self" ? "Private self-thread" : c.kind === "direct" ? "Private conversation" : "Members only"}</span><button class="quiet" id="edit-chat" title="Edit conversation">⋯</button></header><div class="messages"><div class="date">${esc(c.summary || "This is the beginning of this conversation.")}</div>${c.messages.map((m) => `<article class="message ${!m.sender_id ? "operator" : ""}"><div class="avatar">${esc(initials(name(m.sender_id)))}</div><div class="message-content"><div class="message-meta">${esc(name(m.sender_id))}<time>${time(m.created_at)}</time></div><div class="bubble">${renderMessage(m.body, state.chats, m.id)}</div>${deliveryStatus(m, c)}</div></article>`).join("") || '<div class="empty"><div class="avatar">↗</div><h2>Space to think together.</h2><p>Send a request here. The agents in this conversation will start automatically.</p></div>'}</div><form class="composer" id="compose"><div class="compose-box"><textarea id="message" rows="1" placeholder="Message as operator…">${esc(drafts[c.id] || "")}</textarea><button class="primary" title="Send message">↑</button></div><div class="composer-note">Sending wakes ${c.kind === "self" ? "this agent only" : "the conversation members"} · Ctrl/⌘ + Enter to send</div></form>` : `<div class="empty"><div class="avatar">r.</div><h2>Give your agents a place to talk.</h2><p>Add agents with system prompts, set an objective, and run the team. Conversations appear as agents create them; every turn starts with private working notes.</p><button class="quiet" id="welcome-agent">${state.agents.length ? "Add an agent" : "Create your first agent"}</button></div>`}</main><aside class="inspector"><section class="section"><div class="section-head"><h2>Workspace agents <small>${state.agents.length}</small></h2><button id="new-agent">＋ Add</button></div>${state.agents.map((a) => `<div class="agent"><div class="avatar">${esc(initials(a.name))}</div><div><div class="agent-name">${esc(a.name)} <button class="quiet" data-agent-tools="${a.id}" aria-label="Tools for ${esc(a.name)}">Tools${a.tools?.length ? ` · ${a.tools.length}` : ""}</button></div><div class="agent-role">${esc(a.prompt.slice(0, 32))}…</div>${a.error ? `<div class="error-text">${esc(a.error)}</div>` : ""}</div><span class="state ${a.status}">${a.status}</span></div>`).join("") || '<p class="muted">Build a team of specialized agents.</p>'}</section><section class="section run-box"><div class="heading"><h2>Agent harness</h2><span class="eyebrow">Gemma</span></div><p class="muted">Set a shared objective. Agents choose where to talk.</p><textarea id="task" placeholder="What should the team work on?">${esc(task ?? state.run?.task ?? "")}</textarea><div class="agent-creation-settings"><label><input type="checkbox" id="allow-agent-creation" ${state.settings?.allow_agent_creation ? "checked" : ""}> Allow agents to create teammates</label><label>New agents per run <input type="number" id="max-new-agents" min="1" max="10" value="${state.settings?.max_new_agents || 3}"></label><small class="muted">Shares this run’s turn budget. New teammates inherit their creator’s tools. Private chats stay private.</small></div><div class="run-controls"><input id="turns" type="number" min="1" max="100" value="${esc(turns || 12)}" aria-label="Maximum turns"><button class="primary" id="run" ${!state.agents.length ? "disabled" : ""}>${running ? "■ Stop run" : "▶ Run team"}</button></div><p class="muted">${state.run ? `${esc(state.run.status.replaceAll("_", " "))} · ${state.run.turns}/${state.run.maxTurns} turns` : "Bounded turns · All workspace agents"}</p><p class="muted">Selective context · ${
      Object.entries(state.context_usage || {})
        .map(
          ([id, u]) =>
            `${esc(name(id))}: ${(u.bytes / 1000).toFixed(1)}/${(u.budget_bytes / 1000).toFixed(0)} KB`,
        )
        .join(" · ") || "Search and read on demand"
    }</p></section>${c ? `<section class="section"><div class="section-head"><h2>Read positions</h2></div>${c.read_states.map((r) => `<div class="heading muted"><span>${esc(name(r.agent_id))}</span><span>${r.unread_count ? `${r.unread_count} new` : "Up to date"}</span></div>`).join("")}</section>` : ""}<section class="section"><div class="section-head"><h2>Live activity</h2><span class="dot"></span></div>${
      state.history
        .slice(0, 5)
        .map(
          (h) =>
            `<div class="activity"><strong>${esc(name(h.agent_id))} ${h.status === "error" ? "needs attention" : "completed a turn"}</strong>Turn ${h.turn} · ${time(h.at)}${h.message ? `<p class="error-text">${esc(h.message)}</p>` : ""}</div>`,
        )
        .join("") ||
      '<p class="muted">Agent actions will appear here as they work.</p>'
    }</section><div class="privacy">◈ &nbsp; You are the operator.<br>You can monitor every thread. Agents can access only conversations they belong to.</div></aside></div>`;
  document.querySelectorAll("details[data-audit]").forEach((el) => {
    el.open = openAudits.includes(el.dataset.audit);
  });
  if ($(".messages"))
    $(".messages").scrollTop = atBottom ? $(".messages").scrollHeight : scroll;
  if (focus && document.getElementById(focus)) {
    const el = document.getElementById(focus);
    el.focus();
    if (typeof el.setSelectionRange === "function" && el.type !== "number")
      el.setSelectionRange(sel, sel);
  }
  document.querySelectorAll("[data-respond]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          b.disabled = true;
          try {
            const delivery = await api("respond", {
              message_id: Number(b.dataset.respond),
            });
            if (delivery.error) toast(delivery.error);
            else toast("Request queued for the conversation members");
            await refresh();
          } finally {
            b.disabled = false;
          }
        })),
  );
  $("#search").oninput = (e) => {
    query = e.target.value;
    render();
  };
  document.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter;
        render();
      }),
  );
  document.querySelectorAll("[data-chat]").forEach(
    (b) =>
      (b.onclick = () => {
        selected = b.dataset.chat;
        render();
        $(".messages").scrollTop = $(".messages").scrollHeight;
      }),
  );
  for (const id of ["new-agent", "welcome-agent", "sidebar-add-agent"])
    if ($("#" + id)) $("#" + id).onclick = agentModal;
  document
    .querySelectorAll("[data-agent-tools]")
    .forEach((b) => (b.onclick = () => agentToolsModal(b.dataset.agentTools)));
  $("#new-chat").onclick = () => chatModal();
  $("#code-workspace").onclick = () => openCode();
  hydrateChatDiffs();
  $("#search-knowledge").onclick = openKnowledge;
  $("#manage-plugins").onclick = () => act(() => plugins.open());
  if ($("#edit-chat")) $("#edit-chat").onclick = () => chatModal(c);
  if ($("#message")) {
    $("#message").oninput = (e) => (drafts[c.id] = e.target.value);
    $("#message").onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        $("#compose").requestSubmit();
      }
    };
    $("#compose").onsubmit = (e) => {
      e.preventDefault();
      act(async () => {
        const sent = await api("messages", {
          chat_id: c.id,
          body: $("#message").value,
        });
        if (sent.delivery?.error)
          toast("Message saved. " + sent.delivery.error);
        drafts[c.id] = "";
        await refresh();
      });
    };
  }
  const saveAgentSettings = () =>
    act(async () => {
      await api("settings", {
        allow_agent_creation: $("#allow-agent-creation").checked,
        max_new_agents: Number($("#max-new-agents").value),
      });
      await refresh();
    });
  $("#allow-agent-creation").onchange = saveAgentSettings;
  $("#max-new-agents").onchange = saveAgentSettings;
  $("#run").onclick = () =>
    act(async () => {
      if (running) await api("stop", {});
      else
        await api("run", {
          ids: state.agents.map((a) => a.id),
          task: $("#task").value,
          maxTurns: Number($("#turns").value),
        });
      await refresh();
    });
}
async function act(fn) {
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  }
}
function modal(html, submit) {
  const d = $("#modal");
  d.classList.remove("code-modal", "plugin-modal");
  d.innerHTML = `<form id="modal-form">${html}<p id="modal-error" class="error-text" role="alert" hidden></p><div class="actions"><button type="button" id="cancel">Cancel</button><button class="primary">Save</button></div></form>`;
  d.showModal();
  $("#cancel").onclick = () => d.close();
  $("#modal-form").onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target,
      save = form.querySelector("button.primary"),
      error = form.querySelector("#modal-error");
    if (save.disabled) return;
    save.disabled = true;
    error.hidden = true;
    try {
      await submit(new FormData(form), d);
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      save.disabled = false;
    }
  };
}
const plugins = pluginUI({ api, modal, refresh, toast, esc });
function agentToolFields(enabled = []) {
  return `<h3>Tools</h3>${(state.tools || []).map((tool) => `<label class="check"><input type="checkbox" name="tools" value="${esc(tool.name)}" ${enabled.includes(tool.name) ? "checked" : ""}> ${esc(tool.label)}</label><p class="muted">${esc(tool.description)} ${esc(tool.status?.message || "")}</p>`).join("")}<p class="muted">Automatically created teammates inherit the creator’s enabled tools unless a smaller list is specified. Messaging and project tools remain available.</p>`;
}
function agentToolsModal(id) {
  const agent = state.agents.find((a) => a.id === id);
  modal(
    `<h2>Tools for ${esc(agent.name)}</h2>${agentToolFields(agent.tools || [])}`,
    async (form, dialog) => {
      await api("agent-tools", {
        agent_id: id,
        tools: form.getAll("tools"),
      });
      dialog.close();
      await refresh();
    },
  );
}
function agentModal() {
  modal(
    '<h2>Create an agent</h2><p class="muted">A distinct role. A private identity. A place to think.</p><label>Name</label><input name="name" required maxlength="80" placeholder="e.g. Atlas"><label>System prompt</label><textarea name="prompt" rows="6" required maxlength="20000" placeholder="Define the agent’s role, goals and how it should collaborate…"></textarea>' +
      agentToolFields(),
    async (f, d) => {
      const a = await api("agents", {
        ...Object.fromEntries(f),
        tools: f.getAll("tools"),
      });
      await refresh();
      d.innerHTML = `<h2>${esc(a.name)} is ready</h2><p class="muted">This credential lets an external agent use the messaging API. Copy it now; it is shown only once. The built-in harness needs no setup.</p><div class="secret">${esc(a.token)}</div><div class="actions"><button id="close">Done</button></div>`;
      $("#close").onclick = () => d.close();
    },
  );
}
function chatModal(c) {
  modal(
    `<h2>${c ? "Conversation details" : "New conversation"}</h2><label>Name</label><input name="name" required maxlength="100" value="${esc(c?.name || "")}"><label>Short summary / purpose</label><textarea name="summary" rows="3" maxlength="1000">${esc(c?.summary || "")}</textarea>${c ? "" : `<label>Type</label><select name="kind"><option value="group">Group chat</option><option value="direct">Direct message</option><option value="self">Self thread</option></select><label>Members</label>${state.agents.map((a) => `<label class="check"><input type="checkbox" name="members" value="${a.id}">${esc(a.name)}</label>`).join("")}`} ${
      c?.kind === "group"
        ? `<label>Add a member</label><select name="invite"><option value="">No change</option>${state.agents
            .filter((a) => !c.members.includes(a.id))
            .map((a) => `<option value="${a.id}">${esc(a.name)}</option>`)
            .join(
              "",
            )}</select><p class="muted">New members can read the entire group history.</p>`
        : ""
    }`,
    async (f, d) => {
      const data = Object.fromEntries(f);
      const r = await api(c ? "chat-details" : "chats", {
        ...data,
        ...(c ? { chat_id: c.id } : { members: f.getAll("members") }),
      });
      if (c && data.invite)
        await api("members", { chat_id: c.id, agent_id: data.invite });
      selected = r.id;
      d.close();
      await refresh();
    },
  );
}
function openKnowledge() {
  const d = $("#modal");
  d.classList.remove("code-modal");
  d.innerHTML = `<div class="heading"><h2>Search knowledge</h2><button id="close-search">Close</button></div><p class="muted">Search as an agent to see only the conversations and project files it can access. Results are excerpts; open a source for details.</p><form id="knowledge-form"><label>Agent perspective</label><select id="search-agent">${state.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select><label>Search in</label><select id="search-type"><option value="search_messages">Chat messages and private notes</option><option value="search_chats">Conversation names and summaries</option><option value="search_files">Current project files</option><option value="search_file_history">File revision history</option><option value="search_executions">Execution logs</option></select><label>Words to find</label><input id="knowledge-query" required maxlength="300" placeholder="e.g. empty input"><div class="actions"><button class="primary" ${state.agents.length ? "" : "disabled"}>Search</button></div></form><div id="knowledge-results"></div>`;
  d.showModal();
  $("#close-search").onclick = () => d.close();
  let request = 0;
  $("#knowledge-form").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const id = ++request,
        agent_id = $("#search-agent").value,
        type = $("#search-type").value;
      const result = await api("retrieve", {
        agent_id,
        type,
        query: $("#knowledge-query").value,
        limit: 10,
      });
      if (id !== request || !$("#knowledge-results")) return;
      $("#knowledge-results").innerHTML =
        result.results
          .map(
            (r, index) =>
              `<article class="knowledge-hit"><strong>${esc(r.chat_name || r.path || r.id)}</strong><small>${r.revision ? "Revision " + r.revision : r.message_id ? "Message #" + r.message_id : r.status || ""}${r.start_line ? " · line " + r.start_line : ""}</small><pre>${esc(r.snippet)}</pre><button data-source="${index}" class="quiet">Read source →</button></article>`,
          )
          .join("") || '<p class="muted">No accessible matches.</p>';
      if (result.next_offset !== null)
        $("#knowledge-results").insertAdjacentHTML(
          "beforeend",
          '<p class="muted">More results are available. Narrow your search.</p>',
        );
      document.querySelectorAll("[data-source]").forEach(
        (b) =>
          (b.onclick = () =>
            act(async () => {
              const r = result.results[Number(b.dataset.source)];
              const action =
                type === "search_messages"
                  ? { type: "read_message", message_id: r.message_id }
                  : type === "search_chats"
                    ? { type: "read_chat", chat_id: r.chat_id, limit: 10 }
                    : type === "search_executions"
                      ? {
                          type: "read_execution",
                          execution_id: r.id,
                          stream: "stderr",
                        }
                      : {
                          type: "read_file",
                          path: r.path,
                          revision: r.revision,
                          start_line: r.start_line,
                          end_line: undefined,
                        };
              const source = await api("retrieve", { agent_id, ...action });
              let pre = b.parentElement.querySelector(".source-content");
              if (!pre) {
                pre = document.createElement("pre");
                pre.className = "source-content";
                b.parentElement.append(pre);
              }
              pre.textContent =
                source.body ??
                source.content ??
                source.output ??
                JSON.stringify(source, null, 2);
              if (
                source.next ||
                (source.next_offset !== undefined &&
                  source.next_offset !== null) ||
                (source.next_after_message_id !== undefined &&
                  source.next_after_message_id !== null)
              ) {
                const note = document.createElement("small");
                note.textContent =
                  "Showing a bounded excerpt. Agents can retrieve subsequent pages with the returned cursor.";
                b.parentElement.append(note);
              }
            })),
      );
    });
  };
}
let codeFile = null,
  codeHistory = [],
  previousSource = "",
  codeTab = "source",
  fileRequest = 0;
const closedFolders = new Set();
let explorerFolder = "";
function explorerTree() {
  const files = state.coding?.files || [],
    folders = state.coding?.directories || [];
  function children(parent) {
    const prefix = parent ? parent + "/" : "";
    const direct = (p) =>
      p.startsWith(prefix) && !p.slice(prefix.length).includes("/");
    return (
      folders
        .filter((d) => direct(d.path))
        .map(
          (d) =>
            `<details class="explorer-folder" data-folder="${esc(d.path)}" ${closedFolders.has(d.path) ? "" : "open"}><summary title="${esc(d.path)}">📁 ${esc(d.path.split("/").at(-1))}</summary><div class="explorer-children">${children(d.path) || '<small class="muted">Empty folder</small>'}</div></details>`,
        )
        .join("") +
      files
        .filter((f) => direct(f.path))
        .map(
          (f) =>
            `<button data-file="${esc(f.path)}" title="${esc(f.path)}" class="${codeFile?.path === f.path ? "selected" : ""}"><span>▤ ${esc(f.path.split("/").at(-1))}</span><small>v${f.revision} · ${esc(name(f.updated_by))}</small></button>`,
        )
        .join("")
    );
  }
  return (
    children("") ||
    '<p class="muted">No files yet. Create a file or folder to begin.</p>'
  );
}
function fileAuthor(record) {
  return record.source === "external"
    ? "External editor"
    : name(record.updated_by ?? record.actor);
}
function workspaceHistory() {
  return (
    (state.coding?.history || [])
      .map(
        (e) =>
          `<article class="workspace-change"><div><strong>${esc(fileAuthor(e))}</strong> <small>${esc(e.source)} · ${time(e.created_at)}</small><code>${esc(e.git_commit?.slice(0, 8) || "")}</code></div>${e.changes.map((c) => (c.revision ? `<button data-change-path="${esc(c.path)}" data-change-revision="${c.revision}"><span>${esc(c.kind)} · ${esc(c.path)}</span><small>v${c.revision} ↗</small></button>` : `<p class="muted">${esc(c.kind.replaceAll("_", " "))} · ${esc(c.path)}</p>`)).join("")}</article>`,
      )
      .join("") ||
    '<p class="muted">File changes and Git commits will appear here.</p>'
  );
}
function updateEnvironmentControls() {
  if (!$("#use-uv")) return;
  const settings = state.coding?.environment || {},
    busy = state.coding?.busy;
  $("#use-uv").checked = !!settings.use_uv;
  $("#allow-package-install").checked = !!settings.allow_package_install;
  $("#use-uv").disabled = busy;
  $("#allow-package-install").disabled = busy;
  document
    .querySelectorAll("[data-uv-action]")
    .forEach(
      (b) =>
        (b.disabled =
          busy ||
          !settings.use_uv ||
          (b.dataset.uvAction === "sync" && !settings.allow_package_install)),
    );
  $("#uv-run-command").disabled = busy || !settings.use_uv;
}
function updateCodePanels() {
  if (!$("#code-files")) return;
  updateEnvironmentControls();
  $("#code-files").innerHTML = explorerTree();
  if ($("#workspace-history")) {
    $("#workspace-history").innerHTML = workspaceHistory();
    $("#workspace-warnings").textContent = (state.coding?.warnings || []).join(
      " · ",
    );
    $("#workspace-mode").textContent = state.coding?.busy
      ? "Python is running · file changes will sync when it finishes"
      : "Persistent files · Git history · changes sync automatically";
    document.querySelectorAll("[data-change-path]").forEach(
      (b) =>
        (b.onclick = () =>
          act(async () => {
            if (codeDirty() && !confirm("Discard unsaved editor changes?"))
              return;
            await loadCode(
              b.dataset.changePath,
              Number(b.dataset.changeRevision),
            );
            showCodeTab("changes");
          })),
    );
  }
  document.querySelectorAll("[data-folder]").forEach((d) => {
    d.ontoggle = () => {
      if (d.open) closedFolders.delete(d.dataset.folder);
      else closedFolders.add(d.dataset.folder);
    };
    d.querySelector("summary").onclick = () => {
      explorerFolder = d.dataset.folder;
      $("#explorer-location").textContent = "/" + explorerFolder;
    };
  });
  document.querySelectorAll("[data-file]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          if (codeDirty() && !confirm("Discard unsaved editor changes?"))
            return;
          explorerFolder = b.dataset.file.split("/").slice(0, -1).join("/");
          $("#explorer-location").textContent = "/" + explorerFolder;
          const selectedFile = state.coding?.files.find(
            (f) => f.path === b.dataset.file,
          );
          if (selectedFile?.unsupported)
            throw new Error(
              selectedFile.unsupported +
                ". Open the project folder to view this file.",
            );
          await loadCode(b.dataset.file);
        })),
  );
  if (
    codeFile &&
    historicalCode() &&
    $("#latest-code") &&
    state.coding?.files.some((f) => f.path === codeFile.path)
  ) {
    $("#latest-code").hidden = false;
    $("#code-provenance").textContent =
      `Viewing v${codeFile.revision} · A newer revision is available. Load latest to review it.`;
  }
  $("#code-executions").innerHTML =
    (state.coding?.executions || [])
      .map(
        (r) =>
          `<details class="execution" ${r.id === $("#code-executions")?.dataset.latest ? "open" : ""}><summary><span class="state ${r.status === "running" ? "running" : r.status === "succeeded" ? "" : "error"}">${esc(r.status)}</span> ${esc(r.path)} <small>${time(r.started_at)} · ${esc(name(r.actor))}${r.exit_code !== null ? " · exit " + r.exit_code : ""}</small></summary>${r.error ? `<p class="error-text">${esc(r.error)}</p>` : ""}${r.stdout ? `<label>stdout</label><pre>${esc(r.stdout)}</pre>` : ""}${r.stderr ? `<label>stderr</label><pre>${esc(r.stderr)}</pre>` : ""}${r.output_truncated ? '<p class="muted">Output truncated at 32 KB per stream.</p>' : ""}${r.status === "succeeded" && !r.stdout && !r.stderr ? '<p class="muted">Completed without output.</p>' : ""}</details>`,
      )
      .join("") ||
    '<p class="muted">Python execution results will appear here.</p>';
}
function historicalCode() {
  return (
    !!codeFile &&
    (codeFile.kind === "deleted" ||
      codeFile.revision <
        Math.max(
          codeHistory[0]?.revision || 0,
          state.coding?.files.find((f) => f.path === codeFile.path)?.revision ||
            0,
        ))
  );
}
function codeDirty() {
  return (
    $("#code-content") && $("#code-content").value !== (codeFile?.content || "")
  );
}
async function loadCode(path, revision = null) {
  const request = ++fileRequest;
  const [file, history] = await Promise.all([
    api(
      "file?path=" +
        encodeURIComponent(path) +
        (revision ? "&revision=" + revision : ""),
    ),
    api("file-history?path=" + encodeURIComponent(path)),
  ]);
  const previous =
    file.revision > 1
      ? await api(
          "file?path=" +
            encodeURIComponent(path) +
            "&revision=" +
            (file.revision - 1),
        )
      : null;
  if (request !== fileRequest || !$("#code-content")) return;
  codeFile = file;
  codeHistory = history;
  previousSource = previous?.content || "";
  fillCode();
}
function showCodeTab(tab) {
  codeTab = tab;
  document
    .querySelectorAll("[data-code-tab]")
    .forEach((b) => b.classList.toggle("active", b.dataset.codeTab === tab));
  $("#source-panel").hidden = tab !== "source";
  $("#changes-panel").hidden = tab !== "changes";
  $("#history-panel").hidden = tab !== "history";
}
function renderFileReview() {
  const historical = historicalCode();
  $("#code-version").innerHTML =
    codeHistory
      .map(
        (r) =>
          `<option value="${r.revision}" ${r.revision === codeFile?.revision ? "selected" : ""}>v${r.revision} · ${esc(fileAuthor(r))}</option>`,
      )
      .join("") || "<option>Unsaved file</option>";
  $("#code-version").disabled = !codeFile;
  $("#download-code").disabled = !codeFile;
  $("#latest-code").hidden =
    !historical || !state.coding?.files.some((f) => f.path === codeFile?.path);
  $("#code-content").readOnly = historical;
  $("#save-code").disabled = historical;
  $("#run-python").disabled = historical;
  $("#code-provenance").textContent = codeFile
    ? `${historical ? "Historical version · Read only · " : ""}${codeFile.kind === "deleted" ? "Deleted" : "Saved"} by ${fileAuthor(codeFile)} · ${new Date(codeFile.updated_at).toLocaleString()}`
    : "Choose a file to read its source, changes, and author history.";
  const diff = codeFile ? lineDiff(previousSource, codeFile.content) : [];
  $("#changes-summary").textContent = codeFile
    ? `v${codeFile.revision - 1} → v${codeFile.revision} · ${name(codeFile.updated_by)} · +${diff.filter((r) => r.type === "added").length} / −${diff.filter((r) => r.type === "removed").length} lines`
    : "Select a saved file to see changes.";
  $("#code-diff").innerHTML =
    diff
      .map(
        (r) =>
          `<div class="diff-line ${r.type}"><span class="line-number">${r.oldLine ?? ""}</span><span class="line-number">${r.newLine ?? ""}</span><span class="diff-sign">${r.type === "added" ? "+" : r.type === "removed" ? "−" : " "}</span><code>${esc(r.text.replace(/\n$/, ""))}${!r.text.endsWith("\n") ? '<span class="no-newline"> ↵ no trailing newline</span>' : ""}</code></div>`,
      )
      .join("") || '<p class="muted">Empty file.</p>';
  $("#history-panel").innerHTML =
    codeHistory
      .map(
        (r) =>
          `<button class="revision-row ${r.revision === codeFile?.revision ? "selected" : ""}" data-revision="${r.revision}"><span class="revision-badge">v${r.revision}</span><span><strong>${esc(fileAuthor(r))}</strong><small>${esc(new Date(r.updated_at).toLocaleString())}</small></span><span class="muted">${esc(r.kind || (r.revision === 1 ? "Created file" : "Edited file"))} · ${esc(r.git_commit?.slice(0, 8) || "")} ↗</span></button>`,
      )
      .join("") || '<p class="muted">No saved revisions yet.</p>';
  document.querySelectorAll("[data-revision]").forEach(
    (b) =>
      (b.onclick = () =>
        act(async () => {
          if (codeDirty() && !confirm("Discard unsaved editor changes?"))
            return;
          await loadCode(codeFile.path, Number(b.dataset.revision));
          showCodeTab("changes");
        })),
  );
  showCodeTab(codeTab);
}
function fillCode() {
  $("#code-path").value = codeFile?.path || "";
  $("#code-path").disabled = !!codeFile?.revision;
  $("#code-content").value = codeFile?.content || "";
  $("#code-revision").textContent = codeFile?.revision
    ? "Revision " + codeFile.revision
    : "New file";
  updateCodePanels();
  renderFileReview();
}
async function saveCode() {
  const path = $("#code-path").value;
  const result = await api("files/write", {
    path,
    content: $("#code-content").value,
    expected_revision: codeFile?.revision || 0,
  });
  await loadCode(path);
  await refresh();
  toast("File saved · revision " + result.revision);
}
const chatDiffCache = new Map();
function hydrateChatDiffs() {
  document.querySelectorAll(".chat-file-diff").forEach((card) => {
    const path = card.dataset.diffPath,
      revision = Number(card.dataset.diffRevision);
    card.querySelector("[data-open-diff]").onclick = () =>
      act(async () => {
        openCode(true);
        await loadCode(path, revision);
        showCodeTab("changes");
      });
    const key = JSON.stringify([projectId, path, revision]);
    if (!chatDiffCache.has(key)) {
      // Bound retained promises/source previews during long monitoring sessions.
      if (chatDiffCache.size >= 200)
        chatDiffCache.delete(chatDiffCache.keys().next().value);
      chatDiffCache.set(
        key,
        Promise.all([
          api(
            "file?path=" + encodeURIComponent(path) + "&revision=" + revision,
          ),
          revision > 1
            ? api(
                "file?path=" +
                  encodeURIComponent(path) +
                  "&revision=" +
                  (revision - 1),
              )
            : Promise.resolve({ content: "" }),
        ]).then(([after, before]) =>
          renderDiffPreview(before.content, after.content),
        ),
      );
    }
    chatDiffCache
      .get(key)
      .then((html) => {
        if (card.isConnected)
          card.querySelector(".chat-diff-content").innerHTML = html;
      })
      .catch((error) => {
        chatDiffCache.delete(key);
        if (card.isConnected)
          card.querySelector(".chat-diff-content").textContent =
            "Diff unavailable: " + error.message;
      });
  });
}
function openCode(skipInitialFile = false) {
  const d = $("#modal");
  d.classList.add("code-modal");
  explorerFolder = "";
  codeFile = null;
  codeHistory = [];
  previousSource = "";
  codeTab = "source";
  fileRequest++;
  d.innerHTML = `<div class="heading"><div><h2>Code workspace</h2><p class="muted">Read the source. Review every change. See who wrote it.</p></div><button id="close-code">Close</button></div><div class="workspace-location"><code id="workspace-path">${esc(state.coding?.root || "")}</code><button id="copy-workspace-path">Copy path</button><button id="open-workspace-folder">Open folder ↗</button><p id="workspace-mode" class="muted"></p><p id="workspace-warnings" class="error-text"></p></div><section class="environment-panel"><div class="heading"><h3>Project Python environment</h3><label><input id="use-uv" type="checkbox" ${state.coding?.environment?.use_uv ? "checked" : ""}> Use uv for this project</label></div><p class="muted">Environment: .venv/ in this project folder · Private package cache · Excluded from Git and search</p><label><input id="allow-package-install" type="checkbox" ${state.coding?.environment?.allow_package_install ? "checked" : ""}> Allow dependency installation from PyPI</label><div class="uv-controls"><button data-uv-action="init">Initialize project</button><button data-uv-action="venv">Create environment</button><button data-uv-action="sync">Install / sync dependencies</button></div><form id="uv-command-form"><input id="uv-command" aria-label="uv command" placeholder="python -m pytest -q"><button id="uv-run-command">Run with uv</button></form><p id="uv-status" class="muted">Code runs offline. Package downloads require the option above.</p></section><div class="code-layout"><aside><div class="section-head"><h2>Explorer</h2><button id="new-file">＋ File</button><button id="new-folder">＋ Folder</button></div><button id="explorer-root" class="quiet">⌂ Project root</button><p id="explorer-location" class="muted">/</p><div id="code-files"></div><details class="workspace-history-section" open><summary>Workspace history</summary><div id="workspace-history"></div></details></aside><section><div class="code-toolbar"><input id="code-path" placeholder="e.g. main.py" aria-label="File path"><span id="code-revision" class="muted">New file</span><button id="download-code" title="Download the selected saved revision">↓ Download</button><button id="save-code">Save</button><button class="primary" id="run-python">▶ Run Python</button></div><div class="review-toolbar"><div class="tabs"><button data-code-tab="source">Source</button><button data-code-tab="changes">Changes</button><button data-code-tab="history">History</button></div><select id="code-version" aria-label="File revision"></select><button id="latest-code" class="quiet" hidden>Load latest</button></div><p id="code-provenance" class="muted"></p><div id="source-panel"><textarea id="code-content" spellcheck="false" aria-label="Source code" placeholder="Write code here, or let your agents create it…"></textarea></div><div id="changes-panel" hidden><p id="changes-summary" class="muted"></p><div id="code-diff"></div></div><div id="history-panel" hidden></div><p class="muted" id="sandbox-status">Python runs in Docker · /workspace changes persist and are tracked in Git · /tmp is temporary</p><h2>Executions</h2><div id="code-executions"></div></section></div>`;
  d.showModal();
  fillCode();
  const environmentSettings = async () => {
    await api("environment", {
      use_uv: $("#use-uv").checked,
      allow_package_install: $("#allow-package-install").checked,
    });
    await refresh();
    updateEnvironmentControls();
    const status = await api("sandbox");
    if ($("#uv-status"))
      $("#uv-status").textContent = status.ready
        ? "Code runs offline. Installs use the PyPI-only gateway."
        : status.error;
  };
  $("#use-uv").onchange = () => act(environmentSettings);
  $("#allow-package-install").onchange = () => act(environmentSettings);
  const runUv = async (action, args = []) => {
    $("#uv-status").textContent =
      action === "sync"
        ? "Installing dependencies through the PyPI gateway…"
        : "Running in Docker…";
    const r = await api("uv", {
      action,
      args,
      timeout_seconds: action === "sync" ? 180 : 20,
    });
    if ($("#code-executions")) $("#code-executions").dataset.latest = r.id;
    await refresh();
    if ($("#uv-status"))
      $("#uv-status").textContent =
        r.status === "succeeded"
          ? "Completed. See execution output below."
          : r.error || r.stderr || "Execution failed";
  };
  document
    .querySelectorAll("[data-uv-action]")
    .forEach((b) => (b.onclick = () => act(() => runUv(b.dataset.uvAction))));
  $("#uv-command-form").onsubmit = (e) => {
    e.preventDefault();
    act(() => runUv("run", commandArguments($("#uv-command").value)));
  };
  updateEnvironmentControls();
  $("#open-workspace-folder").onclick = () =>
    act(() => api("workspace/open", {}));
  $("#copy-workspace-path").onclick = () =>
    act(async () => {
      await navigator.clipboard.writeText(state.coding.root);
      toast("Project folder path copied");
    });
  $("#close-code").onclick = () => {
    fileRequest++;
    d.close();
  };
  $("#explorer-root").onclick = () => {
    explorerFolder = "";
    $("#explorer-location").textContent = "/";
  };
  $("#new-folder").onclick = () =>
    act(async () => {
      const path = prompt(
        "Folder path relative to project root",
        explorerFolder ? explorerFolder + "/" : "",
      );
      if (!path) return;
      await api("directories", { path });
      explorerFolder = path;
      $("#explorer-location").textContent = "/" + path;
      await refresh();
    });
  $("#new-file").onclick = () => {
    if (codeDirty() && !confirm("Discard unsaved editor changes?")) return;
    fileRequest++;
    codeFile = null;
    codeHistory = [];
    previousSource = "";
    codeTab = "source";
    fillCode();
    $("#code-path").value = explorerFolder ? explorerFolder + "/" : "";
    $("#code-path").focus();
  };
  document
    .querySelectorAll("[data-code-tab]")
    .forEach((b) => (b.onclick = () => showCodeTab(b.dataset.codeTab)));
  $("#code-version").onchange = () =>
    act(async () => {
      if (codeDirty() && !confirm("Discard unsaved editor changes?")) {
        $("#code-version").value = codeFile.revision;
        return;
      }
      await loadCode(codeFile.path, Number($("#code-version").value));
    });
  $("#latest-code").onclick = () => act(() => loadCode(codeFile.path));
  $("#download-code").onclick = () => {
    if (!codeFile) return;
    const url = URL.createObjectURL(
      new Blob([codeFile.content], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = codeFile.path.split("/").at(-1);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $("#save-code").onclick = () => act(saveCode);
  $("#run-python").onclick = () =>
    act(async () => {
      if (historicalCode())
        throw new Error("Load the latest revision before running Python.");
      const b = $("#run-python");
      b.disabled = true;
      try {
        if (!codeFile || codeDirty()) await saveCode();
        b.disabled = true;
        const r = await api("python", {
          path: codeFile.path,
          timeout_seconds: 20,
        });
        if ($("#code-executions")) $("#code-executions").dataset.latest = r.id;
        await refresh();
      } finally {
        b.disabled = historicalCode();
      }
    });
  act(async () => {
    const status = await api("sandbox");
    if (!status.ready && $("#sandbox-status"))
      $("#sandbox-status").textContent = status.error;
  });
  const firstFile = state.coding?.files.find((f) => !f.unsupported);
  if (firstFile && !skipInitialFile) act(() => loadCode(firstFile.path));
}
new EventSource("/api/admin/events").onmessage = () => refresh();
refresh();
