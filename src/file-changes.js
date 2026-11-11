// Messages contain immutable revision references; source is loaded on demand by
// the monitor, rather than consuming the agents' context with full patches.
export function publishFileChanges(
  store,
  workspace,
  actor,
  selfChat,
  activeChat,
  action,
  result,
  before,
) {
  if (
    ![
      "write_file",
      "edit_file",
      "sed",
      "run_python",
      "uv_init",
      "uv_venv",
      "uv_sync",
      "uv_run",
    ].includes(action) ||
    (result.error && !result.changes?.length)
  )
    return;
  const refs = result.changes
    ? result.changes.flatMap((event) => event.changes)
    : result.path && result.revision
      ? [result]
      : [];
  const targets = new Set([selfChat]);
  if (activeChat && store.chat(activeChat).kind !== "self") {
    store.requireMember(activeChat, actor);
    targets.add(activeChat);
  }
  const seen = new Set();
  for (const ref of refs) {
    if (
      !Number.isInteger(ref.revision) ||
      ref.revision < 1 ||
      before.get(ref.path) === ref.revision
    )
      continue;
    const key = JSON.stringify([ref.path, ref.revision]);
    if (seen.has(key)) continue;
    seen.add(key);
    const file = workspace.read(ref.path, ref.revision);
    const previous =
      ref.revision > 1
        ? workspace.read(ref.path, ref.revision - 1).content
        : "";
    if (
      file.content === previous &&
      ref.revision > 1 &&
      file.kind !== "deleted"
    )
      continue;
    const body =
      "File change\n" +
      JSON.stringify({
        path: ref.path,
        revision: ref.revision,
        kind: file.kind || (ref.revision === 1 ? "created" : "modified"),
      });
    for (const chat of targets) store.send(chat, actor, body);
  }
  result.diff_posted = true;
}
