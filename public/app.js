import { pluginUI } from "./plugins.js";
import { commandArguments } from "./commands.js";
import { lineDiff } from "/diff.js";
import { renderMessage, preview, renderDiffPreview } from "/format.js";
const projectId = new URLSearchParams(location.search).get("project");
let state = { agents: [], chats: [], history: [] },
  selected = new URLSearchParams(location.search).get("chat"),
  filter = "all",
  query = "",
  drafts = {};
const chatHistory = new Map();
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
async function api(path, body, scope = projectId, retried = false) {
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
  if (r.status === 401 && !retried) {
    await fetch("/");
    return api(path, body, scope, true);
  }
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
    for (const chat of state.chats) {
      const cached = chatHistory.get(chat.id);
      if (!cached) continue;
      for (const m of chat.messages) cached.messages.set(m.id, m);
      chat.messages = [...cached.messages.values()].sort((a, b) => a.id - b.id);
      chat.next_before = cached.next_before;
    }
    if (!state.chats.some((c) => c.id === selected) && state.chats.length)
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
    `<div class="project-home"><header class="home-nav"><span class="home-brand">r.</span><span>RELAY <small>/ AGENT WORKSPACES</small></span><span class="home-local"><i class="dot"></i>Local workspace</span></header><main class="home-content"><div class="home-heading"><div><div class="eyebrow">Your agent workspaces</div><h1>Ideas in motion.</h1><p>Pick up where your agents left off, or give them something new to explore.</p></div><button class="primary" id="new-project">＋ New project</button></div><div class="section-head"><h2>All projects <small>${projects.length}</small></h2><span class="muted">Separate teams. Persistent conversations.</span></div><div class="project-grid">${projects.map((p) => `<article class="project-card"><div class="heading"><div class="avatar">${esc(initials(p.name))}</div><span class="state ${p.run?.status === "running" ? "running" : ""}">${esc(p.run?.status?.replaceAll("_", " ") || "Ready to start")}</span></div><h2>${esc(p.name)}</h2><p class="project-summary">${esc(p.summary || "A fresh workspace for your agents.")}</p><p class="project-path" title="${esc(p.workspace_path || "")}">${esc(p.workspace_path || "")}</p><div class="project-counts"><span><strong>${p.agents}</strong> agents</span><span><strong>${p.chats}</strong> threads</span><span><strong>${p.messages}</strong> messages</span></div><p class="muted">${p.run ? `Last objective: ${esc(p.run.task.slice(0, 140))}` : "No runs yet. Add agents and set an objective."}</p><div class="project-card-footer"><button class="quiet" data-duplicate-project="${p.id}">Duplicate</button><button class="quiet delete-project" data-delete-project="${p.id}" aria-label="Delete ${esc(p.name)}">Delete</button><a class="review-link" href="/?project=${p.id}">Review ↗</a><button class="${p.run?.task ? "primary" : ""}" data-resume="${p.id}">${p.run?.status === "running" ? "Open live" : p.run?.task ? "Resume" : "Open project"} →</button></div></article>`).join("") || '<div class="home-empty"><div class="avatar">＋</div><h2>Your next project starts here.</h2><p>Create a project, add agents, and let conversations grow as they work.</p></div>'}</div><p class="home-footnote">Each project has its own agents, private notes, and conversation history. New projects start empty.</p></main></div>`;
  document.querySelectorAll("[data-duplicate-project]").forEach((button) => {
    button.onclick = () => {
      const project = projects.find(
        (p) => p.id === button.dataset.duplicateProject,
      );
      modal(
        `<h2>Duplicate ${esc(project.name)}</h2><label>New project name</label><input name="name" required value="${esc(project.name + " (copy)")}"><label>What to copy</label><select name="mode"><option value="setup">Setup only</option><option value="full">Full copy</option></select><p><strong>Setup only:</strong> Agent prompts, tool assignments, plugins, and project settings. Starts with empty chats and files.</p><p><strong>Full copy:</strong> Also includes chats, saved outputs, files, Python environment, and Git history. Stop the source project before copying.</p><p class="muted">Both options copy plugin credentials and create independent storage with all agents stopped. Nothing runs until you start it.</p>`,
        async (form, dialog) => {
          const copy = await api(
            "projects/duplicate",
            { id: project.id, name: form.get("name"), mode: form.get("mode") },
            null,
          );
          dialog.close();
          location.href = "/?project=" + copy.id;
        },
      );
      $("#modal-form button.primary").textContent = "Duplicate project";
    };
  });
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
      '<h2>New project</h2><p class="muted">Starts with a default Lead agent inferred from your project description (editable anytime). Add or let agents recruit teammates as they work.</p><label>Name</label><input name="name" required placeholder="e.g. Research assistant team"><label>Project folder (optional)</label><input name="workspace_path" placeholder="/Users/you/Projects/my-project"><p class="muted">Choose a new or empty folder. Leave blank to create one automatically.</p><label>Short description</label><textarea name="summary" rows="3" placeholder="What is this project for?"></textarea>',
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
                  required_files: p.run.required_files || [],
                  resume: true,
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
  const request = state.requests?.find((r) => r.message_id === message.id);
  if (
    message.sender_id &&
    !request &&
    (chat.kind !== "direct" || chat.messages.at(-1)?.id !== message.id)
  )
    return "";
  const pending = request?.pending_replies || [];
  const label = request?.waiting_for_budget
    ? "Waiting for more turns · Resume or retry"
    : request?.status === "queued"
      ? "Queued for agents"
      : request?.status === "delivered"
        ? pending.length
          ? "Awaiting reply · " +
            pending
              .map((id) => state.agents.find((a) => a.id === id)?.name || id)
              .join(", ")
          : request.responses?.length
            ? request.responses.some((r) => r.outcome === "blocker")
              ? "Blocker reported"
              : "Answered"
            : "Delivered to agents"
        : request?.status === "cancelled"
          ? "Agent response stopped"
          : request?.status === "error"
            ? "Could not process request"
            : chat.read_states.every((r) => r.last_read_id >= message.id)
              ? "Read by agents"
              : "Not yet scheduled";
  const retry =
    !request ||
    ["error", "cancelled"].includes(request.status) ||
    ((pending.length || request?.waiting_for_budget) &&
      state.run?.status !== "running");
  return `<div class="delivery-status ${request?.status === "error" ? "delivery-error" : ""}"><span>${esc(label)}</span>${request?.error ? `<span>${esc(request.error)}</span>` : ""}${retry ? `<button class="quiet" data-respond="${message.id}">${request ? "Retry" : "Ask agents to respond"}</button>` : ""}</div>`;
}
const icon = (c) =>
  c.kind === "group" ? "#" : c.kind === "self" ? "↳" : initials(c.name);
function groupCard(chat) {
  if (chat.kind !== "group" || !chat.group) return "";
  const g = chat.group;
  return `<section class="group-contract"><div class="heading"><strong>${esc(g.status.replaceAll("_", " "))}</strong><span>Owner: ${esc(name(g.owner_id))}</span></div><p>${esc(g.purpose)}</p>${g.completion_criteria ? `<p class="muted">Done when: ${esc(g.completion_criteria)}</p>` : ""}${g.deliverables.length ? `<p>Deliverables: ${g.deliverables.map(esc).join(", ")}</p>` : ""}${g.blockers.length ? `<p class="error-text">Blocked: ${g.blockers.map(esc).join("; ")}</p>` : ""}<div class="actions"><button class="quiet" id="manage-group">Manage group</button><button class="quiet" id="group-decisions">Decisions (${g.decision_count})</button><button class="quiet" id="group-history">History</button>${g.final_message_id ? `<button class="quiet" id="group-final" data-message-id="${g.final_message_id}">Final report ↗</button>` : ""}</div></section>`;
}
function manageGroup(chat) {
  const g = chat.group;
  modal(
    `<h2>Group workspace</h2><label>Purpose</label><textarea name="purpose" required>${esc(g.purpose)}</textarea><label>Owner</label><select name="owner_id">${chat.members.map((id) => `<option value="${id}" ${id === g.owner_id ? "selected" : ""}>${esc(name(id))}</option>`).join("")}</select><label>Status</label><select name="status">${["active", "awaiting_input", "blocked", "resolved"].map((status) => `<option value="${status}" ${status === g.status ? "selected" : ""}>${status.replaceAll("_", " ")}</option>`).join("")}</select><label>Member roles</label>${chat.members.map((id) => `<label>${esc(name(id))}</label><input name="role:${id}" value="${esc(g.roles[id] || "")}">`).join("")}<label>Deliverable file paths (one per line)</label><textarea name="deliverables">${esc(g.deliverables.join("\n"))}</textarea><label>Completion criteria</label><textarea name="completion_criteria">${esc(g.completion_criteria)}</textarea><label>Blockers (one per line)</label><textarea name="blockers">${esc(g.blockers.join("\n"))}</textarea><label>Final report message ID</label><input name="final_message_id" type="number" min="1" value="${g.final_message_id || ""}"><p class="muted">Resolving requires a report in this group, existing deliverables, and no pending decisions or blockers. Criteria express the owner's judgment; they are not automatically fact-checked.</p>`,
    async (form, dialog) => {
      const lines = (key) =>
        String(form.get(key))
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean);
      await api("group-settings", {
        chat_id: chat.id,
        purpose: form.get("purpose"),
        owner_id: form.get("owner_id"),
        status: form.get("status"),
        roles: Object.fromEntries(
          chat.members.map((id) => [id, form.get("role:" + id)]),
        ),
        deliverables: lines("deliverables"),
        blockers: lines("blockers"),
        completion_criteria: form.get("completion_criteria"),
        final_message_id: form.get("final_message_id")
          ? Number(form.get("final_message_id"))
          : null,
      });
      dialog.close();
      await refresh();
    },
  );
}
async function groupDecisions(chat, offset = 0) {
  const detail = await api(
    "group?chat_id=" + encodeURIComponent(chat.id) + "&offset=" + offset,
  );
  modal(
    `<h2>Decisions · ${esc(chat.name)}</h2><div class="decision-list">${detail.decisions.results.map((d) => `<article class="decision-item"><strong>${esc(d.title)}</strong><p>${esc(d.status)} · ${esc(name(d.author))}</p><p>${esc(d.rationale)}</p><p class="muted">Evidence: ${d.evidence.map((ref) => (typeof ref === "number" ? "Message #" + ref : esc(ref))).join(" · ") || "None yet"}</p><div class="actions"><button type="button" data-decision="${d.id}" data-status="accepted">Accept</button><button type="button" data-decision="${d.id}" data-status="rejected">Reject</button><button type="button" data-decision="${d.id}" data-status="proposed">Reopen proposal</button></div></article>`).join("") || '<p class="muted">No decisions recorded.</p>'}</div><div class="actions">${offset ? '<button type="button" id="first-decisions">First page</button>' : ""}${detail.decisions.next_offset !== null ? '<button type="button" id="next-decisions">Next page</button>' : ""}</div><h3>Record a decision</h3><label>Title</label><input name="title" required><label>Rationale / alternatives considered</label><textarea name="rationale" required></textarea><label>Evidence (one URL or group message ID per line)</label><textarea name="evidence"></textarea><label>Status</label><select name="status"><option value="proposed">Proposed</option><option value="accepted">Accepted</option><option value="rejected">Rejected</option></select>`,
    async (form, dialog) => {
      await api("group-decision", {
        chat_id: chat.id,
        title: form.get("title"),
        rationale: form.get("rationale"),
        status: form.get("status"),
        evidence: String(form.get("evidence"))
          .split("\n")
          .map((v) => v.trim())
          .filter(Boolean)
          .map((v) => (/^\d+$/.test(v) ? Number(v) : v)),
      });
      dialog.close();
      await refresh();
    },
  );
  document.querySelectorAll("[data-decision]").forEach((button) => {
    button.onclick = () =>
      act(async () => {
        await api("group-decision", {
          chat_id: chat.id,
          decision_id: button.dataset.decision,
          status: button.dataset.status,
        });
        $("#modal").close();
        await refresh();
        await groupDecisions(
          state.chats.find((c) => c.id === chat.id),
          offset,
        );
      });
  });
  if ($("#next-decisions"))
    $("#next-decisions").onclick = () =>
      act(async () => {
        $("#modal").close();
        await groupDecisions(chat, detail.decisions.next_offset);
      });
  if ($("#first-decisions"))
    $("#first-decisions").onclick = () =>
      act(async () => {
        $("#modal").close();
        await groupDecisions(chat, 0);
      });
}
async function groupHistory(chat, offset = 0) {
  const detail = await api(
    "group?view=history&chat_id=" +
      encodeURIComponent(chat.id) +
      "&offset=" +
      offset,
  );
  modal(
    `<h2>Group history</h2>${detail.history.results.map((event) => `<details><summary>${esc(event.event.replaceAll("_", " "))} · ${esc(name(event.actor))} · ${esc(event.created_at)}</summary><pre class="plugin-output">${esc(JSON.stringify(event.data, null, 2))}</pre></details>`).join("") || "No changes recorded."}${detail.history.next_offset !== null ? '<button type="button" id="more-group-history">Older changes</button>' : ""}`,
    async (_, dialog) => dialog.close(),
  );
  $("#modal-form button.primary").textContent = "Close";
  if ($("#more-group-history"))
    $("#more-group-history").onclick = () =>
      act(async () => {
        $("#modal").close();
        await groupHistory(chat, detail.history.next_offset);
      });
}
function liveActivities(chatId) {
  if (state.run?.status !== "running") return [];
  return Object.values(state.activity || {}).filter(
    (a) =>
      a.run_id === state.run.id &&
      (chatId === undefined || a.chat_id === chatId),
  );
}
function activityLabel(a) {
  return a.phase === "preparing"
    ? "Waiting for model"
    : a.phase === "writing_note"
      ? "Writing a working note"
      : a.phase === "sending"
        ? "Sending a message"
        : a.phase === "reading"
          ? "Reading" + (a.tool ? " · " + a.tool.replaceAll("_", " ") : "")
          : "Working" + (a.tool ? " · " + a.tool.replaceAll("_", " ") : "");
}
function chatActivity(chatId, compact = false) {
  const activities = liveActivities(chatId);
  if (!activities.length) return "";
  const waiting = activities.some((a) => a.phase === "preparing");
  return `<div class="chat-activity ${compact ? "compact" : ""}" ${compact ? "" : 'role="status" aria-live="polite"'}><span class="typing-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>${activities.map((a) => `${esc(name(a.agent_id))} · ${esc(activityLabel(a))}`).join("<br>")}${!compact && waiting ? "<br><small>This chat is being used as context. The response may go to another chat.</small>" : ""}</span></div>`;
}
function agentActivity(agentId) {
  const a = liveActivities().find((a) => a.agent_id === agentId);
  if (!a) return "";
  const chat = state.chats.find((c) => c.id === a.chat_id);
  return chat
    ? `<button class="quiet agent-chat-activity" data-activity-chat="${esc(chat.id)}">${esc(activityLabel(a))} in ${esc(chat.name)} ↗</button>`
    : '<div class="agent-chat-activity">Preparing first working note…</div>';
}
function render() {
  const openAudits = [
    ...document.querySelectorAll("details[data-audit][open]"),
  ].map((el) => el.dataset.audit);
  const focus = document.activeElement?.id,
    sel = document.activeElement?.selectionStart,
    selectionEnd = document.activeElement?.selectionEnd,
    selectionDirection = document.activeElement?.selectionDirection;
  const oldScroll = $(".messages"),
    atBottom =
      !oldScroll ||
      oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight <
        80,
    scroll = oldScroll?.scrollTop || 0,
    chatListScroll = $(".chat-list")?.scrollTop || 0,
    inspectorScroll = $(".inspector")?.scrollTop || 0;
  const task = $("#task")?.value,
    turns = $("#turns")?.value,
    maxNewAgents =
      focus === "max-new-agents"
        ? ($("#max-new-agents")?.value ?? state.settings?.max_new_agents ?? 3)
        : (state.settings?.max_new_agents ?? 3),
    defaultTask =
      state.run?.task || state.project?.summary || state.project?.name || "",
    taskValue =
      task !== undefined && (task !== "" || focus === "task")
        ? task
        : defaultTask;
  const c = state.chats.find((c) => c.id === selected),
    running = state.run?.status === "running";
  $("#app").innerHTML =
    `<div class="layout"><nav class="rail"><div class="brand">r.</div><div class="rail-icon">☷</div><div title="Private agent workspace">◈</div><div class="rail-bottom">RELAY / WORKSPACE</div></nav><aside class="sidebar"><div class="sidebar-top"><div class="heading"><h1>Conversations</h1><button class="quiet" id="new-chat" title="New conversation">＋</button></div><p class="subtitle"><a href="/">← Projects</a> / ${esc(state.project?.name || "Workspace")}</p><button class="quiet" id="sidebar-add-agent">＋ Add agent</button><button class="quiet model-shortcut" id="manage-models"><strong>Change model</strong><span>${esc(state.model?.label || state.model?.name || "Configure model")}</span></button><input id="search" class="search" placeholder="Search conversations…" value="${esc(query)}"><div class="tabs">${[
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
            `${c.name} ${c.summary} ${c.members.map(name).join(" ")}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .map(
          (c) =>
            `<button class="chat-row ${selected === c.id ? "selected" : ""} ${liveActivities(c.id).length ? "chat-active" : ""}" data-chat="${c.id}"><div class="avatar ${c.kind}">${esc(icon(c))}</div><div class="row-copy"><div class="row-title"><span>${esc(c.name)}</span>${c.kind === "self" ? `<span class="chat-owner" title="${esc(name(c.members[0]))}">${esc(name(c.members[0]))}</span>` : ""}</div>${chatActivity(c.id, true) || `<div class="row-preview">${esc(preview(c.messages.at(-1)?.body || c.summary || "No messages yet"))}</div>`}<div class="row-preview">${c.kind === "self" ? `${esc(name(c.members[0]))} · Personal workspace` : c.members.length + " members"} · ${c.messages.length} messages</div></div></button>`,
        )
        .join("") ||
      '<p class="muted" style="padding:12px">Your conversations will appear here.</p>'
    }</div><div class="sidebar-foot"><button id="manage-plugins" class="quiet">⊞ Tools & plugins</button><button id="search-knowledge" class="quiet" title="Search accessible messages, source and executions">⌕ Search</button><button id="code-workspace" class="quiet">⌘ Code workspace <small>${state.coding?.files.length || 0}</small></button></div></aside><main class="main">${c ? `<header class="chat-head"><div class="avatar ${c.kind}">${esc(icon(c))}</div><div><h2>${esc(c.name)}</h2><p>${esc(c.members.map(name).join(", "))}</p></div><span class="badge">${c.kind === "self" ? `${esc(name(c.members[0]))} · Private self-thread` : c.kind === "direct" ? "Private conversation" : "Members only"}</span><button class="quiet" id="edit-chat" title="Edit conversation">⋯</button></header><div class="messages">${groupCard(c)}<div class="date">${esc(c.summary || "This is the beginning of this conversation.")}</div>${c.next_before ? `<button class="quiet" id="load-older">Load older messages</button>` : ""}${c.messages.map((m) => `<article id="message-${m.id}" class="message ${!m.sender_id ? "operator" : ""}"><div class="avatar">${esc(initials(name(m.sender_id)))}</div><div class="message-content"><div class="message-meta">${esc(name(m.sender_id))}<time>${time(m.created_at)}</time></div><div class="bubble">${renderMessage(m.body, state.chats, m.id)}</div>${deliveryStatus(m, c)}</div></article>`).join("") || '<div class="empty"><div class="avatar">↗</div><h2>Space to think together.</h2><p>Send a request here. The agents in this conversation will start automatically.</p></div>'}${chatActivity(c.id)}</div><form class="composer" id="compose"><div class="compose-box"><textarea id="message" rows="1" placeholder="Message as operator…">${esc(drafts[c.id] || "")}</textarea><button class="primary" title="Send message">↑</button></div><div class="composer-note">Sending wakes ${c.kind === "self" ? "this agent only" : "the conversation members"} · Ctrl/⌘ + Enter to send</div></form>` : `<div class="empty"><div class="avatar">r.</div><h2>${state.agents.length ? esc(state.project?.name || "Your team is ready.") : "Give your agents a place to talk."}</h2><p>${state.agents.length ? esc(state.project?.summary || "Your Lead agent is configured and ready. Run the team to start working notes and conversations, or add more teammates.") : "Add agents with system prompts, set an objective, and run the team. Conversations appear as agents create them; every turn starts with private working notes."}</p><div class="actions">${state.agents.length ? `<button class="primary" id="welcome-run">${running ? "■ Stop run" : "▶ Run team"}</button>` : ""}<button class="quiet" id="welcome-agent">${state.agents.length ? "＋ Add an agent" : "Create your first agent"}</button></div></div>`}</main><aside class="inspector"><section class="section"><div class="section-head"><h2>Workspace agents <small>${state.agents.length}</small></h2><button id="new-agent">＋ Add</button></div>${state.agents.map((a) => `<div class="agent"><div class="avatar">${esc(initials(a.name))}</div><div><div class="agent-name">${esc(a.name)} <button class="quiet" data-agent-tools="${a.id}" aria-label="Tools for ${esc(a.name)}">Edit / Tools${a.tools?.length ? ` · ${a.tools.length}` : ""}</button></div><div class="agent-role" data-agent-tools="${a.id}" title="Click to view or edit system prompt">${esc(a.prompt.slice(0, 48))}${a.prompt.length > 48 ? "…" : ""}</div>${agentActivity(a.id)}${a.error ? `<div class="error-text">${esc(a.error)}</div>` : ""}</div><span class="state ${a.status}">${a.status}</span></div>`).join("") || '<p class="muted">Build a team of specialized agents.</p>'}</section><section class="section run-box"><div class="heading"><h2>Agent harness</h2><button id="harness-models" class="quiet">Models · ${esc((running && (state.run?.model?.label || state.run?.model?.name)) || state.model?.label || state.model?.name || "Configure")}</button></div><p class="muted">Set a shared objective. Agents choose where to talk.</p><textarea id="task" placeholder="What should the team work on?">${esc(taskValue)}</textarea><label for="required-files">Required output files (one path per line)</label><textarea id="required-files" rows="2" placeholder="reports/findings.md">${esc($("#required-files")?.value ?? (state.run?.required_files || []).join("\n"))}</textarea><div class="agent-creation-settings"><label><input type="checkbox" id="allow-agent-creation" ${state.settings?.allow_agent_creation ? "checked" : ""}> Allow agents to create teammates</label><label>New agents per run <input type="number" id="max-new-agents" min="1" max="10" value="${esc(maxNewAgents)}"></label><small class="muted">Shares this run’s turn budget. New teammates inherit their creator’s tools. Private chats stay private.</small></div><div class="run-controls"><input id="turns" type="number" min="1" max="100" value="${esc(turns ?? 12)}" aria-label="Maximum turns"><button class="primary" id="run" ${!state.agents.length ? "disabled" : ""}>${running ? "■ Stop run" : "▶ Run team"}</button></div><p class="muted">${state.run ? `${esc(state.run.status.replaceAll("_", " "))} · ${state.run.turns}/${state.run.maxTurns} turns` : "Bounded turns · All workspace agents"}</p><p class="muted">Completion checks: ${esc(state.run?.completion?.status?.replaceAll("_", " ") || "Pending")} · checks delivery, declared files, and source access; not factual correctness.</p><p class="muted">Selective context · ${
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
  if ($("#load-older"))
    $("#load-older").onclick = () =>
      act(async () => {
        const button = $("#load-older");
        button.disabled = true;
        const chatId = c.id;
        const anchor = $(".messages .message")?.id;
        const top = anchor
          ? document.getElementById(anchor).getBoundingClientRect().top
          : 0;
        try {
          const page = await api(
            "messages?chat_id=" +
              encodeURIComponent(chatId) +
              "&before=" +
              c.next_before,
          );
          const current = state.chats.find((chat) => chat.id === chatId);
          const cached = chatHistory.get(chatId) || { messages: new Map() };
          for (const m of [
            ...c.messages,
            ...(current?.messages || []),
            ...page.messages,
          ])
            cached.messages.set(m.id, m);
          cached.next_before = page.next_before;
          chatHistory.set(chatId, cached);
          if (current) {
            current.messages = [...cached.messages.values()].sort(
              (a, b) => a.id - b.id,
            );
            current.next_before = page.next_before;
          }
          render();
          if (selected === chatId && anchor && document.getElementById(anchor))
            $(".messages").scrollTop +=
              document.getElementById(anchor).getBoundingClientRect().top - top;
        } finally {
          if (button.isConnected) button.disabled = false;
        }
      });
  $("#manage-models").onclick = () => act(modelsModal);
  $("#harness-models").onclick = () => act(modelsModal);
  document.querySelectorAll("[data-activity-chat]").forEach((button) => {
    button.onclick = () => {
      selected = button.dataset.activityChat;
      filter = "all";
      query = "";
      render();
    };
  });
  document.querySelectorAll("details[data-audit]").forEach((el) => {
    el.open = openAudits.includes(el.dataset.audit);
  });
  if ($(".chat-list")) $(".chat-list").scrollTop = chatListScroll;
  if ($(".inspector")) $(".inspector").scrollTop = inspectorScroll;
  if ($(".messages"))
    $(".messages").scrollTop = atBottom ? $(".messages").scrollHeight : scroll;
  if (focus && document.getElementById(focus)) {
    const el = document.getElementById(focus);
    el.focus({ preventScroll: true });
    // Inputs such as checkboxes expose this method but do not support selection.
    if (
      typeof sel === "number" &&
      typeof el.selectionStart === "number" &&
      typeof el.setSelectionRange === "function"
    )
      el.setSelectionRange(sel, selectionEnd, selectionDirection);
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
    if ($(".chat-list")) $(".chat-list").scrollTop = 0;
    render();
  };
  document.querySelectorAll("[data-filter]").forEach(
    (b) =>
      (b.onclick = () => {
        filter = b.dataset.filter;
        if ($(".chat-list")) $(".chat-list").scrollTop = 0;
        render();
      }),
  );
  document.querySelectorAll("[data-chat]").forEach(
    (b) =>
      (b.onclick = () => {
        selected = b.dataset.chat;
        render();
        if ($(".messages"))
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
  if ($("#manage-group")) $("#manage-group").onclick = () => manageGroup(c);
  if ($("#group-history"))
    $("#group-history").onclick = () => act(() => groupHistory(c));
  if ($("#group-decisions"))
    $("#group-decisions").onclick = () => act(() => groupDecisions(c));
  if ($("#group-final"))
    $("#group-final").onclick = () =>
      act(async () => {
        const detail = await api(
          "group?view=report&chat_id=" + encodeURIComponent(c.id),
        );
        if (!detail.report) throw new Error("Final report is unavailable");
        modal(
          `<h2>Final report</h2><p class="muted">Message #${detail.report.id} · ${esc(name(detail.report.sender_id))}</p>${renderMessage(detail.report.body, state.chats, detail.report.id)}`,
          async (_, dialog) => dialog.close(),
        );
        $("#modal-form button.primary").textContent = "Close";
      });
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
  const toggleRun = () =>
    act(async () => {
      if (running) await api("stop", {});
      else
        await api("run", {
          ids: state.agents.map((a) => a.id),
          task:
            $("#task").value.trim() ||
            state.project?.summary ||
            state.project?.name ||
            "",
          maxTurns: Number($("#turns").value),
          required_files: $("#required-files")
            .value.split("\n")
            .map((p) => p.trim())
            .filter(Boolean),
        });
      await refresh();
    });
  $("#run").onclick = toggleRun;
  if ($("#welcome-run")) $("#welcome-run").onclick = toggleRun;
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
async function modelsModal() {
  const catalog = await api("models");
  const choices = [catalog.default, ...catalog.models];
  modal(
    `<h2>Model connections</h2><p>Connections are shared across projects. Choose a model for this project; active runs keep their original configuration.</p><label>Project model</label><select name="model_id">${choices.map((c) => `<option value="${esc(c.id || "")}" ${(c.id || null) === (state.model_id || null) ? "selected" : ""}>${esc(c.label || c.name)}</option>`).join("")}</select><div class="actions"><button type="button" id="add-model">Add connection</button><button type="button" id="edit-model">Edit selected</button><button type="button" id="test-model">Test selected</button></div><p id="model-test-result" role="status"></p>`,
    async (form, dialog) => {
      await api("model", { id: form.get("model_id") || null });
      dialog.close();
      await refresh();
    },
  );
  const chosen = () => $("#modal select[name=model_id]").value;
  $("#add-model").onclick = () => editModelConnection();
  $("#edit-model").onclick = () => {
    const item = catalog.models.find((c) => c.id === chosen());
    if (!item)
      return toast(
        "Edit configs/model.toml for the local default, or add a connection.",
      );
    editModelConnection(item);
  };
  $("#test-model").onclick = () =>
    act(async () => {
      const output = $("#model-test-result");
      output.textContent = "Waiting for the configured endpoint…";
      try {
        const result = await api("models/test", { id: chosen() || null });
        output.textContent = `Connected to ${result.model} · ${(result.elapsed_ms / 1000).toFixed(1)}s · valid JSON response`;
      } catch (e) {
        output.textContent = e.message;
        throw e;
      }
    });
}
function editModelConnection(c = {}) {
  modal(
    `<h2>${c.id ? "Edit" : "Add"} model connection</h2>
    <label>Display name</label><input name="label" required value="${esc(c.label || "")}" placeholder="Research model">
    <label>API base URL</label><input name="api_base" type="url" required value="${esc(c.api_base || "")}" placeholder="https://openrouter.ai/api/v1">
    <label>Model ID (exact provider name)</label><input name="name" required value="${esc(c.name || "")}" placeholder="provider/model or your vLLM deployment name">
    <label>API key environment variable (optional)</label><input name="api_key_env" value="${esc(c.api_key_env || "")}" placeholder="MODEL_API_KEY">
    <label>Or save an API key locally</label><input name="credential" type="password" autocomplete="new-password" placeholder="${c.has_credential ? "Saved key; leave blank to keep" : "Optional for endpoints without authentication"}">
    <label><input type="checkbox" name="clear_credential"> Clear saved key</label>
    <p class="muted">Keys are stored in local application data, never returned to agents or the browser. An environment variable in .env avoids storing a key in the database.</p>
    <label>Response format</label><select name="output_mode">${["json_schema", "json_object", "text"].map((v) => `<option ${(c.output_mode || "json_schema") === v ? "selected" : ""} value="${v}">${{ json_schema: "JSON Schema", json_object: "JSON object", text: "Prompt-only JSON (no response_format)" }[v]}</option>`).join("")}</select>
    <label>Output token parameter</label><select name="token_parameter">${["max_tokens", "max_completion_tokens"].map((v) => `<option ${c.token_parameter === v ? "selected" : ""}>${v}</option>`).join("")}</select>
    <label>Output token budget</label><input type="number" name="max_tokens" min="128" max="262144" value="${c.max_tokens || 4096}" required>
    <label>Context window tokens</label><input type="number" name="context_window_tokens" min="2048" max="2000000" value="${c.context_window_tokens || 65536}" required>
    <label>Timeout seconds</label><input type="number" name="timeout_seconds" min="1" max="600" value="${c.timeout_seconds || 120}" required>
    <label>Temperature (blank to omit)</label><input type="number" name="temperature" min="0" max="2" step="0.1" value="${c.temperature === null ? "" : (c.temperature ?? 0)}">
    <label>Extra request body (JSON, optional provider settings)</label><textarea name="extra_body" rows="4">${esc(JSON.stringify(c.extra_body || {}, null, 2))}</textarea>
    <p class="muted">For OpenRouter, vLLM, or a LiteLLM proxy. Support depends on the selected endpoint and model. Extra settings cannot override credentials, messages, or output controls.</p>`,
    async (form, dialog) => {
      const data = Object.fromEntries(form);
      for (const k of [
        "max_tokens",
        "context_window_tokens",
        "timeout_seconds",
      ])
        data[k] = Number(data[k]);
      data.temperature =
        data.temperature === "" ? null : Number(data.temperature);
      data.extra_body = JSON.parse(data.extra_body || "{}");
      if (data.clear_credential) data.credential = "";
      else if (!data.credential) delete data.credential;
      delete data.clear_credential;
      if (c.id) data.id = c.id;
      await api("models", data);
      dialog.close();
      await modelsModal();
    },
  );
}
function agentToolsModal(id) {
  const agent = state.agents.find((a) => a.id === id);
  modal(
    `<h2>Edit ${esc(agent.name)}</h2><label>Name</label><input name="name" required value="${esc(agent.name)}"><label>System prompt</label><textarea name="prompt" rows="6" required>${esc(agent.prompt)}</textarea>${agentToolFields(agent.tools || [])}`,
    async (form, dialog) => {
      await api("agent-tools", {
        agent_id: id,
        name: form.get("name"),
        prompt: form.get("prompt"),
        tools: form.getAll("tools"),
      });
      dialog.close();
      await refresh();
    },
  );
}
function agentModal() {
  modal(
    '<h2>Create an agent</h2><p class="muted">A distinct role. A private identity. A place to think.</p><label>Name</label><input name="name" required placeholder="e.g. Atlas"><label>System prompt</label><textarea name="prompt" rows="6" required placeholder="Define the agent’s role, goals and how it should collaborate…"></textarea>' +
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
    `<h2>${c ? "Conversation details" : "New conversation"}</h2><label>Name</label><input name="name" required value="${esc(c?.name || "")}"><label>Short summary / purpose</label><textarea name="summary" rows="3">${esc(c?.summary || "")}</textarea>${c ? "" : `<label>Type</label><select name="kind"><option value="group">Group chat</option><option value="direct">Direct message</option><option value="self">Self thread</option></select><label>Members</label>${state.agents.map((a) => `<label class="check"><input type="checkbox" name="members" value="${a.id}">${esc(a.name)}</label>`).join("")}`} ${
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
  const filesScroll = $("#code-files")?.scrollTop || 0,
    historyScroll = $("#workspace-history")?.scrollTop || 0,
    execScroll = $("#code-executions")?.scrollTop || 0;
  updateEnvironmentControls();
  $("#code-files").innerHTML = explorerTree();
  $("#code-files").scrollTop = filesScroll;
  if ($("#workspace-history")) {
    $("#workspace-history").innerHTML = workspaceHistory();
    $("#workspace-history").scrollTop = historyScroll;
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
          `<details class="execution" ${r.id === $("#code-executions")?.dataset.latest ? "open" : ""}><summary><span class="state ${r.status === "running" ? "running" : r.status === "succeeded" ? "" : "error"}">${esc(r.status)}</span> ${esc(r.path)} <small>${time(r.started_at)} · ${esc(name(r.actor))}${r.exit_code !== null ? " · exit " + r.exit_code : ""}</small></summary>${r.error ? `<p class="error-text">${esc(r.error)}</p>` : ""}${r.stdout ? `<label>stdout</label><pre>${esc(r.stdout)}</pre>` : ""}${r.stderr ? `<label>stderr</label><pre>${esc(r.stderr)}</pre>` : ""}${["stdout", "stderr"].map((stream) => (r[stream + "_artifact_id"] ? `<button class="quiet" data-artifact="${esc(r[stream + "_artifact_id"])}">View complete ${stream} ↗</button>` : "")).join("")}${r.output_complete === false ? '<p class="error-text">Capture did not complete; saved output remains available.</p>' : ""}${r.output_truncated ? '<p class="muted">Output truncated at 32 KB per stream.</p>' : ""}${r.status === "succeeded" && !r.stdout && !r.stderr && !r.stdout_characters && !r.stderr_characters ? '<p class="muted">Completed without output.</p>' : ""}</details>`,
      )
      .join("") ||
    '<p class="muted">Python execution results will appear here.</p>';
  $("#code-executions").scrollTop = execScroll;
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
async function openArtifact(id) {
  const d = $("#modal");
  d.classList.remove("code-modal", "plugin-modal");
  d.classList.add("plugin-modal");
  d.innerHTML = `<div class="heading"><h2>Complete output</h2><button id="close-output">Close</button></div><p id="output-page" class="muted"></p><div class="actions"><button id="output-prev">Previous page</button><button id="output-next">Next page</button><a id="output-download">Download complete output</a></div><form id="output-search"><input name="query" required placeholder="Find text in full output"><button>Search</button></form><div id="output-matches"></div><pre id="output-text" class="plugin-output"></pre>`;
  const outputElement = $("#output-text");
  d.showModal();
  $("#close-output").onclick = () => d.close();
  $("#output-download").href =
    "/api/admin/artifact?project=" +
    encodeURIComponent(projectId) +
    "&id=" +
    encodeURIComponent(id) +
    "&download=1";
  let current = 0,
    next = null,
    history = [];
  const load = async (offset) => {
    const page = await api(
      "artifact?id=" + encodeURIComponent(id) + "&offset=" + offset,
    );
    if ($("#output-text") !== outputElement) return;
    current = offset;
    next = page.next_offset;
    $("#output-text").textContent = page.text;
    $("#output-page").textContent =
      `${page.label} · Characters ${offset}–${offset + page.text.length} of ${page.total_characters} · ${page.source_complete ? "Complete stored output" : "Capture still open or interrupted"}`;
    $("#output-prev").disabled = !history.length;
    $("#output-next").disabled = next === null;
  };
  $("#output-prev").onclick = () => act(() => load(history.pop()));
  $("#output-next").onclick = () =>
    act(async () => {
      history.push(current);
      await load(next);
    });
  const search = async (query, offset = 0) => {
    const result = await api(
      "artifact-search?id=" +
        encodeURIComponent(id) +
        "&query=" +
        encodeURIComponent(query) +
        "&offset=" +
        offset,
    );
    if ($("#output-text") !== outputElement) return;
    $("#output-matches").innerHTML =
      result.matches
        .map(
          (m) =>
            `<button data-output-offset="${m.offset}">Match at ${m.offset}</button>`,
        )
        .join("") || "No matches";
    $("#output-matches")
      .querySelectorAll("[data-output-offset]")
      .forEach((b) => {
        b.onclick = () =>
          act(async () => {
            history.push(current);
            await load(Number(b.dataset.outputOffset));
          });
      });
    if (result.next_offset !== null) {
      const more = document.createElement("button");
      more.textContent = "Next matches";
      more.onclick = () => act(() => search(query, result.next_offset));
      $("#output-matches").append(more);
    }
  };
  $("#output-search").onsubmit = (e) => {
    e.preventDefault();
    const query = new FormData(e.target).get("query");
    act(() => search(query));
  };
  await load(0);
}
document.addEventListener("click", (e) => {
  const button = e.target.closest("[data-artifact]");
  if (button) act(() => openArtifact(button.dataset.artifact));
});
new EventSource("/api/admin/events").onmessage = (e) => {
  if (!projectId || e.data === "update" || e.data === projectId) refresh();
};
refresh();
