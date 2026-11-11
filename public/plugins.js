export const weatherPlugin = {
  version: 1,
  name: "plugin_weather",
  label: "Weather forecast",
  description:
    "Get current temperature and weather conditions for a latitude and longitude. Temperatures are in Celsius. Use coordinates supplied by the user or established from evidence.",
  endpoint: "https://api.open-meteo.com/v1/forecast",
  method: "GET",
  parameters: {
    latitude: {
      type: "number",
      required: true,
      description: "Latitude in degrees",
    },
    longitude: {
      type: "number",
      required: true,
      description: "Longitude in degrees",
    },
  },
  fixed: { current: "temperature_2m,weather_code" },
  auth: { type: "none" },
  response_path: "",
  enabled: true,
  example: { latitude: 43.65, longitude: -79.38 },
};

export function pluginUI({ api, modal, refresh, toast, esc }) {
  const $ = (selector) => document.querySelector(selector);
  const json = (value) => JSON.stringify(value, null, 2);
  const exportManifest = (plugin) => {
    const { has_credential, ...manifest } = plugin;
    const url = URL.createObjectURL(
      new Blob([json(manifest)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = plugin.name + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  async function open() {
    const plugins = await api("plugins");
    const d = $("#modal");
    d.classList.remove("code-modal");
    d.classList.add("plugin-modal");
    d.innerHTML = `<div class="heading"><div><h2>Tools & plugins</h2><p class="muted">Connect an API, then enable its tool for the agents that need it.</p></div><button id="plugins-close">Close</button></div><div class="plugin-actions"><button class="primary" id="plugin-add">＋ Add HTTP plugin</button><button id="plugin-weather">Use weather template</button><label class="plugin-import">Import manifest<input id="plugin-import" type="file" accept=".json,application/json"></label></div><p class="muted">Plugins belong to this project. Install a JSON manifest or define a public HTTPS API. Credentials stay on the server and are excluded from exports.</p><p id="plugins-error" class="error-text" role="alert"></p><div class="plugin-list">${plugins.map((p) => `<article class="plugin-card"><div class="heading"><strong>${esc(p.label)}</strong><span class="badge">${p.enabled ? "Enabled" : "Disabled"}</span></div><p>${esc(p.description)}</p><code>${esc(p.method)} ${esc(p.endpoint)}</code><p class="muted">${esc(p.name)} · ${p.auth.type === "none" ? "No credential needed" : p.has_credential ? "Credential saved" : "Credential needed"}</p><div class="plugin-actions"><button data-plugin-edit="${esc(p.name)}">Edit</button><button data-plugin-test="${esc(p.name)}" ${!p.enabled ? "disabled" : ""}>Test request</button><button data-plugin-export="${esc(p.name)}">Export</button><button data-plugin-remove="${esc(p.name)}" class="quiet delete-project">Remove</button></div></article>`).join("") || '<p class="muted">No HTTP plugins installed. Start with the weather template or import a manifest.</p>'}</div><p class="muted">Built-in tools, including web search, are managed through each agent’s Tools button. Installing a plugin does not automatically enable it for agents.</p>`;
    d.showModal();
    $("#plugins-close").onclick = () => d.close();
    $("#plugin-add").onclick = () =>
      edit({
        version: 1,
        name: "plugin_my_tool",
        label: "",
        description: "",
        endpoint: "",
        method: "GET",
        parameters: { query: { type: "string", required: true } },
        fixed: {},
        auth: { type: "none" },
        response_path: "",
        enabled: true,
        example: { query: "example" },
      });
    $("#plugin-weather").onclick = () => edit(structuredClone(weatherPlugin));
    $("#plugin-import").onchange = async (event) => {
      try {
        const file = event.target.files[0];
        if (!file) return;
        if (file.size > 64000) throw Error("Manifest must be at most 64 KB");
        edit(JSON.parse(await file.text()));
      } catch (error) {
        $("#plugins-error").textContent = error.message;
      }
    };
    for (const button of d.querySelectorAll("[data-plugin-edit]"))
      button.onclick = () =>
        edit(
          plugins.find((p) => p.name === button.dataset.pluginEdit),
          true,
        );
    for (const button of d.querySelectorAll("[data-plugin-export]"))
      button.onclick = () =>
        exportManifest(
          plugins.find((p) => p.name === button.dataset.pluginExport),
        );
    for (const button of d.querySelectorAll("[data-plugin-test]"))
      button.onclick = () =>
        test(plugins.find((p) => p.name === button.dataset.pluginTest));
    for (const button of d.querySelectorAll("[data-plugin-remove]"))
      button.onclick = async () => {
        if (
          !confirm(
            "Remove this plugin and revoke it from all agents in this project?",
          )
        )
          return;
        try {
          await api("plugins/remove", { name: button.dataset.pluginRemove });
          await refresh();
          await open();
        } catch (error) {
          $("#plugins-error").textContent = error.message;
        }
      };
  }
  function edit(plugin, existing = false) {
    if (!plugin || typeof plugin !== "object" || Array.isArray(plugin))
      throw Error("Manifest must be a JSON object");
    if (plugin.version !== 1)
      throw Error("Only plugin manifest version 1 is supported");
    modal(
      `<h2>${existing ? "Edit" : "Install"} HTTP plugin</h2><p class="muted">Review the service and inputs below. GET sends query parameters; POST sends a JSON body.</p><div class="plugin-grid"><div><label>Tool ID</label><input name="plugin_name" required pattern="plugin_[a-z][a-z0-9_]{1,48}" value="${esc(plugin.name)}" ${existing ? "readonly" : ""}><label>Display name</label><input name="label" required maxlength="80" value="${esc(plugin.label)}"><label>Description for agents</label><textarea name="description" required maxlength="1500" rows="3">${esc(plugin.description)}</textarea><label>HTTPS endpoint</label><input name="endpoint" type="url" required placeholder="https://api.example.com/search" value="${esc(plugin.endpoint)}"><label>Method</label><select name="method"><option ${plugin.method === "GET" ? "selected" : ""}>GET</option><option ${plugin.method === "POST" ? "selected" : ""}>POST</option></select><label>Authentication</label><select name="auth_type">${["none", "bearer", "header"].map((type) => `<option value="${type}" ${plugin.auth?.type === type ? "selected" : ""}>${{ none: "None", bearer: "Bearer token", header: "API key header" }[type]}</option>`).join("")}</select><label>API key header name (header authentication)</label><input name="auth_header" value="${esc(plugin.auth?.header || "X-API-Key")}"><label>Credential ${plugin.has_credential ? "(saved; leave blank to keep)" : ""}</label><input type="password" name="credential" autocomplete="new-password"><p class="muted">Changing the endpoint or authentication requires re-entering the credential.</p></div><div><label>Input parameters (JSON)</label><textarea class="plugin-json" name="parameters" rows="7" required>${esc(json(plugin.parameters || {}))}</textarea><p class="muted">Each input has type string, number or boolean, plus optional required and description fields.</p><label>Fixed parameters (JSON)</label><textarea class="plugin-json" name="fixed" rows="3">${esc(json(plugin.fixed || {}))}</textarea><label>Example / test arguments (JSON)</label><textarea class="plugin-json" name="example" rows="4" required>${esc(json(plugin.example || {}))}</textarea><label>Response field (optional)</label><input name="response_path" placeholder="e.g. data.results" value="${esc(plugin.response_path || "")}"><label class="check"><input type="checkbox" name="enabled" ${plugin.enabled !== false ? "checked" : ""}> Enable plugin</label></div></div>`,
      async (form, dialog) => {
        const manifest = {
          version: 1,
          name: form.get("plugin_name"),
          label: form.get("label"),
          description: form.get("description"),
          endpoint: form.get("endpoint"),
          method: form.get("method"),
          parameters: JSON.parse(form.get("parameters")),
          fixed: JSON.parse(form.get("fixed") || "{}"),
          example: JSON.parse(form.get("example")),
          response_path: form.get("response_path"),
          enabled: form.has("enabled"),
          auth: {
            type: form.get("auth_type"),
            ...(form.get("auth_type") === "header"
              ? { header: form.get("auth_header") }
              : {}),
          },
        };
        const credential = form.get("credential");
        await api("plugins/save", {
          manifest,
          ...(credential ? { credential } : {}),
        });
        dialog.close();
        await refresh();
        await open();
        toast("Plugin saved. Enable it through an agent’s Tools button.");
      },
    );
    $("#modal").classList.add("plugin-modal");
    $("#modal-form button.primary").textContent = existing
      ? "Save plugin"
      : "Install plugin";
  }
  function test(plugin) {
    modal(
      `<h2>Test ${esc(plugin.label)}</h2><p class="muted">Send a real ${esc(plugin.method)} request to ${esc(plugin.endpoint)}.</p><label>Arguments (JSON)</label><textarea class="plugin-json" name="arguments" rows="7">${esc(json(plugin.example))}</textarea><pre id="plugin-test-output" class="plugin-output"></pre>`,
      async (form) => {
        const result = await api("plugins/test", {
          name: plugin.name,
          arguments: JSON.parse(form.get("arguments")),
        });
        $("#plugin-test-output").textContent = json(result);
      },
    );
    $("#modal").classList.add("plugin-modal");
    $("#modal-form button.primary").textContent = "Run test";
  }
  return { open };
}
