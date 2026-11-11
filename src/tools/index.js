import webSearch from "./web-search.js";

// Add an imported definition here. The UI, permission validation, model action
// schema, instructions, dispatch, logging and delegation use this registry.
export const tools = new Map([webSearch].map((tool) => [tool.name, tool]));
export function availableTools(context) {
  return context.store?.availableTools() || tools;
}
export function toolCatalog(context) {
  return [...availableTools(context).values()].map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    example: tool.example,
    status: tool.status?.(context) || { configured: true, message: "Ready" },
  }));
}
export function toolInstructions(enabled, context) {
  const catalog = toolCatalog(context).filter((tool) =>
    enabled.includes(tool.name),
  );
  return (
    "\nOptional tools enabled for you: " +
    JSON.stringify(catalog) +
    "\nOnly call tools listed above. Inspect tool results on your next turn before answering or finishing. If a tool is not configured, report that to the operator instead of repeatedly retrying. create_agent inherits your optional tools when tools is omitted. Supply tools:[] for none or an explicit subset to restrict a teammate. You cannot delegate tools you do not have."
  );
}
