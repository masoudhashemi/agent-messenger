export const managedDirectories = new Set([
  ".venv",
  ".uv-cache",
  ".cache",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);
export const excludedWorkspacePath = (path) =>
  path.split("/").some((part) => managedDirectories.has(part));
