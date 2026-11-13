import { AppError } from "./store.js";

export function workFor(run, actor) {
  return ((run.work ||= {})[actor] ||= {
    errors: {},
    reply_targets: [],
    deliveries: [],
    required_files: [],
    searched: false,
    status: "working",
  });
}
export function addReplyTarget(run, actor, message, explicit = false) {
  const work = workFor(run, actor);
  const existing = work.reply_targets.find((r) => r.message_id === message.id);
  if (existing) {
    if (explicit) existing.explicit = true;
  } else
    work.reply_targets.push({
      chat_id: message.chat_id,
      message_id: message.id,
      explicit,
    });
}
export function workContext(work, store = null, actor = null, since = null) {
  return {
    reply_targets: work.reply_targets,
    shared_group_id: work.shared_group_id || null,
    synthesis_group_id: work.synthesis_group_id || null,
    required_files: work.required_files,
    unresolved_tools: Object.values(work.errors),
    research_requires_citations: work.searched,
    ...(store && actor
      ? {
          retrieved_sources: store.sources.observedSources(actor, ""),
          search_artifacts: store.sources.searchArtifacts(actor, ""),
        }
      : {}),
    status: work.status,
  };
}
export function declareFiles(work, paths, workspace) {
  if (
    !workspace ||
    !Array.isArray(paths) ||
    paths.length > 30 ||
    paths.some((p) => typeof p !== "string")
  )
    throw new AppError(
      "required_files must be an array of at most 30 workspace paths",
    );
  for (const path of paths) {
    workspace.path(path);
    if (!work.required_files.includes(path)) work.required_files.push(path);
  }
  return work.required_files;
}
export function completionProblems(store, workspace, run, actor) {
  const work = workFor(run, actor),
    problems = [];
  if (Object.values(work.errors).length)
    problems.push(
      "Resolve failed tools before finishing: " +
        Object.values(work.errors).join(", "),
    );
  for (const target of work.reply_targets) {
    const chat = store.chat(target.chat_id);
    const deliveryIds =
      chat.kind === "group"
        ? Object.values(run.work || {}).flatMap((w) => w.deliveries)
        : work.deliveries;
    const response = target.explicit
      ? (work.resolved_requests || []).includes(target.message_id)
      : deliveryIds.some((id) => {
          const message = store.get(
            "SELECT chat_id,id FROM messages WHERE id=?",
            id,
          );
          return (
            message &&
            message.chat_id === target.chat_id &&
            message.id > target.message_id
          );
        });
    if (!response)
      problems.push(
        `Reply to chat ${target.chat_id} for request ${target.message_id}`,
      );
  }
  if (work.synthesis_group_id) {
    const group = store.groups.info(work.synthesis_group_id);
    if (group.status !== "resolved")
      problems.push(
        "Publish the final report in group " +
          work.synthesis_group_id +
          " and resolve its contract before finishing (or finish as blocked with an explanation)",
      );
  }
  for (const path of work.required_files) {
    try {
      if (workspace.read(path).kind === "deleted") throw new Error();
    } catch {
      problems.push("Missing required file: " + path);
    }
  }
  if (work.searched) {
    const urls = new Set(store.sources.observedUrls(actor, ""));
    // A lead may cite evidence handed off in a message it actually received.
    for (const row of store.all(
      "SELECT m.body FROM message_reads r JOIN messages m ON m.id=r.message_id WHERE r.agent_id=? AND m.sender_id!=? AND m.created_at>=?",
      actor,
      actor,
      "",
    ))
      for (const url of row.body.match(/https?:\/\/[^\s<>\])]+/g) || [])
        urls.add(url);
    const delivered = work.deliveries
      .map(
        (id) =>
          store.get("SELECT body FROM messages WHERE id=?", id)?.body || "",
      )
      .join("\n");
    if (![...urls].some((url) => delivered.includes(url)))
      problems.push(
        "Research needs a delivered finding citing a source you retrieved with read_source, or a source URL from a handoff you read. Search indexes alone are not evidence.",
      );
  }
  return problems;
}
