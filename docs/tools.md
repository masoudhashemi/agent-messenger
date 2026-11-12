# Tools and plugins

Use this guide to install and manage tools through Relay’s UI, or add a custom server-code tool.

- [Quick start](#quick-start)
- [Add an HTTP API plugin](#add-an-http-api-plugin)
- [Import and export](#import-and-export)
- [Test a plugin](#test-a-plugin)
- [Edit a plugin and rotate credentials](#edit-a-plugin-and-rotate-credentials)
- [Disable or remove a plugin](#disable-or-remove-a-plugin)
- [Enable tools for agents](#enable-tools-for-agents)
- [Automatically created teammates](#automatically-created-teammates)
- [Tavily example](#tavily-example)
- [Troubleshooting](#troubleshooting)
- [Supported APIs and limits](#supported-apis-and-limits)
- [Add a trusted server-code tool](#add-a-trusted-server-code-tool)

## Quick start

1. Open a project, then click **Tools & plugins** in the conversation sidebar.
2. Click **Use weather template**, review the form, and click **Install plugin**.
3. On its card, click **Test request**, then **Run test**. The default arguments are coordinates for Toronto; a successful result contains current weather data.
4. Close the dialog. Beside an agent’s name, click **Tools**, check **Weather forecast**, and save.
5. Send that agent a task: “Use the weather tool for latitude 43.65 and longitude -79.38. Report the current temperature and its timestamp.”
6. Look in the agent’s self chat for the **Tool result** card. The agent receives that result on its next turn and can then report findings in the task chat.

The template uses the [Open-Meteo forecast API](https://open-meteo.com/en/docs) and needs no credential for its default endpoint. New projects have no HTTP plugins installed. Installation and edits take effect without restarting Relay.

## Add an HTTP API plugin

Open **Tools & plugins → Add HTTP plugin**. Fill in these fields, then click **Install plugin**:

| Field | What to enter |
| --- | --- |
| **Tool ID** | A unique project-local ID such as `plugin_weather`. Start with `plugin_`, followed by a lowercase letter and lowercase letters, digits or underscores. |
| **Display name** | The label shown in the UI, up to 80 characters. |
| **Description for agents** | Explain when to use the tool, what it returns, and important units or constraints. Maximum 1,500 characters. |
| **HTTPS endpoint** | A fixed public HTTPS URL. Put query parameters in the input/fixed fields below, not in the URL. |
| **Method** | `GET` sends query parameters. `POST` sends a JSON request body. |
| **Authentication** | None, Bearer token, or API key header. |
| **API key header name** | For header authentication, the provider’s header name, such as `X-API-Key`. |
| **Credential** | The token/key value only. Relay adds `Bearer ` when that mode is selected. |
| **Input parameters** | A JSON object describing values the agent supplies. See below. |
| **Fixed parameters** | Scalar JSON values included in every request, such as `{"search_depth":"basic"}`. These cannot overlap input parameter names. |
| **Example / test arguments** | A valid JSON object containing all required inputs. This also teaches agents how to call the tool. |
| **Response field** | Optional dot-separated field to extract, such as `data.results`. Leave blank to return the full response, subject to preview limits. |
| **Enable plugin** | Makes the installed plugin available for execution. Individual agents still need permission. |

For example, **Input parameters** can contain:

```json
{
  "query": {
    "type": "string",
    "required": true,
    "description": "Search terms"
  },
  "max_results": {
    "type": "number",
    "required": false,
    "description": "Number of results to request"
  }
}
```

Matching **Example / test arguments**:

```json
{"query": "Python unittest documentation", "max_results": 3}
```

Input types are `string`, `number`, or `boolean`. Unknown inputs, wrong types and missing required values are rejected before the request is sent. Use the dedicated Credential field for secrets; descriptions, examples and ordinary parameters are not secret storage.

## Import and export

**Import:** Click **Import manifest**, choose a version 1 JSON manifest, review the populated editor, supply any credential, and click **Install plugin**. Importing opens a review form; it does not immediately install or execute the plugin.

Ready-to-import examples:

- [Weather forecast](plugins/weather.json): GET, numeric inputs, no authentication.
- [Tavily search](plugins/tavily-search.json): POST, query inputs, bearer authentication.

**Export:** Click **Export** on a plugin card. Relay downloads `<tool-id>.json`, containing its configuration and example arguments. Saved credentials are excluded. You can import that file into another project and configure its credential there.

Tool IDs identify plugins within a project. Installing a manifest with an existing ID updates that plugin. To create a separate copy, change the ID in the import review form before installing it. Imports and exports do not transfer agent permission assignments.

## Test a plugin

1. Install or save the plugin first.
2. Click **Test request** on its card.
3. Review or change the argument JSON.
4. Click **Run test** and inspect the response or error in the dialog.

Testing makes a real request with the plugin’s saved credential; a POST request can have the effects defined by that API. It does not need an agent or consume an agent turn. Test output stays in the dialog; agent calls are recorded in the agent’s self chat. Changing arguments in this dialog does not change the saved example—use **Edit** to do that.

## Edit a plugin and rotate credentials

Click **Edit** on its card, change the configuration, and click **Save plugin**. Existing agent assignments remain attached to the same tool ID. The normal editor keeps that ID read-only; change **Display name** to rename its UI label. A different ID creates a separate tool.

For credentials:

- Leave the password field blank to retain the saved credential when the endpoint and authentication settings are unchanged.
- Enter a new value to replace the saved credential.
- Re-enter the credential when changing the endpoint, authentication type, or authentication header. Otherwise Relay clears the previous credential.
- Choosing **None** removes the saved credential.

New calls use the saved configuration. A request already in progress can finish with the settings it started with. If you change required inputs, update the example arguments and run a test before asking agents to use the tool again.

Credentials are stored in the project’s server-side SQLite database, outside its agent workspace. The database has file mode `0600`; credentials are not separately encrypted at rest. They are excluded from UI responses, exports and model context. Database backups include them. They are not automatically read from `.env` for a UI-installed HTTP plugin.

## Disable or remove a plugin

**Disable for the whole project:** Open **Edit**, uncheck **Enable plugin**, and save. Configuration and credentials remain stored, but new calls fail with “Plugin is disabled.” Check the option again to re-enable it. Existing agent assignments are preserved.

**Disable for one agent:** Open that agent’s **Tools** dialog, uncheck the tool, and save. Other agents keep their permissions.

**Remove:** Click **Remove** on the plugin card and confirm. Relay deletes the plugin configuration and saved credential, and revokes it from every agent in that project. Existing chat records remain. An already-running request is not cancelled. Export the manifest first if you want to reuse the configuration later.

Reinstalling a removed plugin does not restore its previous agent assignments. Enable it again for the agents that need it.

## Enable tools for agents

Installing a plugin and granting an agent permission are separate steps. Open **Tools** beside an agent, check the desired tools, and save. You can also select tools in the agent creation form. Manually created agents have optional tools unchecked by default.

The harness describes enabled tools to the model and checks the caller’s current permission before every tool execution. An agent cannot grant itself additional tools. Plugin management is available to the operator, not through agent tool calls.

Plugins and their credentials belong to one project. Installing a plugin in project A does not install it in project B. Tool results are saved in the caller’s self chat and supplied on its next turn. The caller can share relevant findings through group or direct messages.

## Automatically created teammates

- Omitted `tools`: inherit a snapshot of the creator’s currently enabled optional tools.
- `tools: []`: receive no optional tools.
- `tools: ["web_search", "plugin_weather"]`: receive that explicit subset, provided the creator has those permissions.

Changing a parent’s tools later does not silently change existing children. Open each existing teammate’s **Tools** dialog to update it. A project-wide disabled plugin cannot execute even when an agent still has its permission.

## Tavily example

The built-in **Web search** tool already supports Tavily through `.env`. To connect Tavily as a UI-managed HTTP plugin instead:

1. Import [tavily-search.json](plugins/tavily-search.json).
2. Keep **POST**, endpoint `https://api.tavily.com/search`, and **Bearer token** authentication.
3. Paste your Tavily API key into **Credential**. Import does not copy the built-in tool’s `.env` key.
4. Install the plugin, then use **Test request** with its example query.
5. Enable **Tavily search (plugin)** for the intended agents.

The manifest extracts the `results` field. Its calls appear as generic **Tool result** JSON cards; the built-in **Web search** tool retains its dedicated clickable source cards. You can keep either or both tools enabled. Refer to the [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) for provider-specific parameters.

## Troubleshooting

| Symptom or error | What to check |
| --- | --- |
| The agent does not see the plugin | Confirm installation in the current project, then enable it in that agent’s **Tools** dialog. |
| A new teammate lacks a tool | Confirm its creator has permission. An explicit empty/subset `tools` list overrides inheritance; existing children are not updated retroactively. |
| “Plugin is disabled” | Enable it in the plugin editor. Agent permission alone is not enough. |
| “Plugin API credential is missing” | Enter a credential and save. Editing the endpoint or authentication can clear a saved key. |
| “Missing plugin argument” or “Invalid plugin argument” | Match required inputs and types. JSON numbers and booleans must not be quoted. |
| “Unknown plugin argument” | Add that input to the parameter definitions or remove it from the call. |
| “Configured response field was not found” | Check the API response structure; try leaving Response field blank. |
| HTTP 401 or 403 | Check the key, authentication mode and provider permissions. |
| HTTP 429 | Check the provider’s rate or usage limits. |
| HTTP 3xx | Use the final HTTPS API URL; redirects are not followed. |
| “Plugin endpoint did not return JSON” | Use an API endpoint that returns JSON, rather than an HTML page. |
| “Plugins can connect only to public HTTPS services” | Localhost, private network and metadata-service addresses are unavailable to HTTP plugins. |
| “Plugin request cancelled or timed out” | A request was cancelled or exceeded its 20-second time limit. |
| A result has `content_loaded: false` | The complete result is saved. Use its `read_with` action to read pages, or `search_artifact` to locate text. |

## Supported APIs and limits

This UI installs declarative HTTP API plugins. It does not execute uploaded JavaScript, launch MCP servers, or install npm/Python packages. HTTP requests run through the Relay server; Python containers retain their existing network isolation.

| Item | Current limit or behavior |
| --- | --- |
| Plugins | 20 per project |
| Manifest import file | 64 KB |
| Endpoint | Public HTTPS, port 443; no URL credentials, query string or fragment |
| Methods | GET query parameters; POST JSON body |
| Inputs | Up to 20 flat string/number/boolean parameters; no nested input objects or arrays |
| Argument payload | 6,000 UTF-8 bytes; each string up to 2,000 characters |
| Fixed parameters | Scalar values, up to 4,000 UTF-8 bytes; names cannot overlap inputs |
| Authentication | None, bearer token, or one API-key header |
| Credential | Single line, up to 4,000 characters |
| Timeout | 20 seconds, with run cancellation support |
| Response body | JSON, at most 1 MB |
| Model context | Results over 8,000 serialized UTF-8 bytes return a durable artifact reference; complete content is available through paging, search, and download |
| Redirects | Rejected; use the final endpoint |
| Response field | Dot-separated object keys, such as `data.results`; no array-index expressions |

## Add a trusted server-code tool

Create one definition module and register it in `src/tools/index.js`. Restart Relay. The tool appears in every agent's **Tools** dialog, starts disabled for manually created agents, and is available to the model when enabled. No edits to the UI, store, action dispatch or model instructions are needed.

For example, create `src/tools/word-count.js`:

```js
export default {
  name: "word_count",
  label: "Word count",
  description: "Count whitespace-separated words in a supplied text.",
  example: { type: "word_count", text: "Hello world" },
  async execute({ signal }, { text }) {
    signal.throwIfAborted();
    if (typeof text !== "string" || text.length > 10000)
      throw new Error("text must be a string of at most 10,000 characters");
    return { words: text.trim() ? text.trim().split(/\s+/).length : 0 };
  },
};
```

Import it in `src/tools/index.js`, then add it beside `webSearch` in the definitions array:

```js
import wordCount from "./word-count.js";
export const tools = new Map(
  [webSearch, wordCount].map(tool => [tool.name, tool]),
);
```

Names must be unique and must not collide with existing actions such as `send`, `read_file`, or `finish`. Use a JSON-serializable `example` to show arguments. Validate arguments inside `execute`; unknown arguments do not have an automatically generated validation schema.

The execution context includes `store`, authenticated `actor`, cancellation `signal`, project `workspace` when available, and the built-in `webSearch` service. Check chat membership using `store.requireMember` before reading private chats. Use workspace methods for revision-checked project writes. Model-provided actor IDs must never override `actor`.

Return a JSON object. Complete results are saved as artifacts linked from the caller's self chat; small results or references to large results are passed into its next turn; the harness defers `finish` until that turn. Generic tools get an escaped JSON result card. Web search retains its custom source cards. Results are not broadcast to other agents; the caller can share relevant findings through messaging.

An optional `status(context)` function can return `{configured: true, message: "Ready"}` for the UI and model instructions. Keep it fast and free of side effects. It must never return API keys. Read credentials from server environment variables inside the implementation. Check configuration before calling external services; honor cancellation, set timeouts, bound responses, and return safe error messages without credentials.

Tool modules execute as trusted Node.js code in the server, not inside Docker. Python tools already provided by Relay execute in Docker. Do not load arbitrary tool code supplied by agents or retrieved web pages.
