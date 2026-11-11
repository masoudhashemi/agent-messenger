import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { toolCatalog } from "../src/tools/index.js";
import { weatherPlugin } from "../public/plugins.js";
import {
  validateManifest,
  httpPluginTool,
  publicJsonRequest,
  isPublicAddress,
} from "../src/http-plugins.js";

test("UI plugin manifests persist, remain project scoped, update dynamic schema and revoke permissions on removal", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-plugins-"));
  let s = new Store(join(dir, "project.sqlite"));
  const other = new Store();
  try {
    const manifest = { ...weatherPlugin, auth: { type: "bearer" } };
    const saved = s.savePlugin(manifest, "secret-api-key");
    assert.equal(saved.has_credential, true);
    assert.ok(!JSON.stringify(saved).includes("secret-api-key"));
    const agent = s.createAgent("A", "Research", [manifest.name]);
    const h = new Harness(s);
    assert.ok(
      h
        .responseSchema()
        .properties.actions.items.properties.type.enum.includes(manifest.name),
    );
    assert.ok(
      toolCatalog(h).some(
        (t) => t.name === manifest.name && t.status.configured,
      ),
    );
    assert.throws(
      () => other.createAgent("B", "Research", [manifest.name]),
      /Supported optional tools/,
    );
    s.db.close();
    s = new Store(join(dir, "project.sqlite"));
    assert.equal(s.plugins()[0].has_credential, true);
    s.savePlugin({ ...manifest, label: "Renamed" });
    assert.equal(s.plugins()[0].has_credential, true);
    s.savePlugin({ ...manifest, endpoint: "https://example.com/new" });
    assert.equal(s.plugins()[0].has_credential, false);
    s.removePlugin(manifest.name);
    assert.deepEqual(s.agent(agent.id).tools, []);
    assert.equal(s.plugins().length, 0);
    assert.equal(s.availableTools().has(manifest.name), false);
  } finally {
    s.db.close();
    other.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP plugin execution validates arguments, pins endpoint, formats GET/POST, redacts credentials and bounds results", async () => {
  const manifest = validateManifest({
    ...weatherPlugin,
    auth: { type: "header", header: "X-API-Key" },
    response_path: "result",
  });
  let calls = 0;
  const tool = httpPluginTool(
    manifest,
    () => 'key-"secret',
    async (url, opts) => {
      calls++;
      assert.equal(url.hostname, "api.open-meteo.com");
      assert.equal(url.searchParams.get("latitude"), "43.65");
      assert.equal(opts.headers["X-API-Key"], 'key-"secret');
      return { result: { value: 10, echo: 'key-"secret' } };
    },
  );
  const result = await tool.execute({}, { arguments: weatherPlugin.example });
  assert.equal(result.data.value, 10);
  assert.equal(result.data.echo, "[redacted]");
  await assert.rejects(
    tool.execute({}, { arguments: { latitude: "bad", longitude: 2 } }),
    /Invalid plugin argument/,
  );
  await assert.rejects(
    tool.execute(
      {},
      {
        arguments: {
          ...weatherPlugin.example,
          endpoint: "https://other.example",
        },
      },
    ),
    /Unknown plugin argument/,
  );
  assert.equal(calls, 1);
  const post = httpPluginTool(
    { ...manifest, method: "POST", response_path: "" },
    () => "key",
    async (url, opts) => {
      assert.equal(url.search, "");
      assert.equal(JSON.parse(opts.body).latitude, 43.65);
      return { large: "x".repeat(20000) };
    },
  );
  const large = await post.execute({}, { arguments: weatherPlugin.example });
  assert.equal(large.truncated, true);
  assert.ok(JSON.stringify(large).length < 12000);
  await assert.rejects(
    httpPluginTool({ ...manifest, enabled: false }, () => "key").execute(
      {},
      { arguments: weatherPlugin.example },
    ),
    /disabled/,
  );
  await assert.rejects(
    httpPluginTool(manifest, () => "").execute(
      {},
      { arguments: weatherPlugin.example },
    ),
    /credential is missing/,
  );
});

test("manifest validation and network guard reject unsafe destinations and malformed schemas", async () => {
  for (const endpoint of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com/?key=x",
    "https://example.com:1234",
  ])
    assert.throws(() => validateManifest({ ...weatherPlugin, endpoint }));
  assert.throws(() => validateManifest({ ...weatherPlugin, name: "send" }));
  assert.throws(() =>
    validateManifest({
      ...weatherPlugin,
      parameters: JSON.parse('{"__proto__":{"type":"string"}}'),
    }),
  );
  assert.throws(() =>
    validateManifest({ ...weatherPlugin, fixed: { latitude: 5 } }),
  );
  assert.throws(() =>
    validateManifest({
      ...weatherPlugin,
      auth: { type: "header", header: "Host" },
    }),
  );
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.2",
    "172.16.0.1",
    "0.0.0.0",
    "::1",
    "2001::1",
    "2002:7f00:1::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
  const options = {
    method: "GET",
    headers: {},
    signal: AbortSignal.timeout(1000),
  };
  await assert.rejects(
    publicJsonRequest(new URL("https://127.0.0.1"), options),
    /public HTTPS/,
  );
  await assert.rejects(
    publicJsonRequest(new URL("https://example.com"), options, async () => [
      { address: "10.0.0.1", family: 4 },
    ]),
    /public HTTPS/,
  );
});

test("installed plugins inherit to children and default to off for manually created agents", () => {
  const s = new Store();
  try {
    s.savePlugin(weatherPlugin);
    const parent = s.createAgent("Parent", "Delegate", [weatherPlugin.name]);
    assert.deepEqual(s.createAgent("Manual", "Work").tools, []);
    const h = new Harness(s);
    h.configure({ allow_agent_creation: true, max_new_agents: 1 });
    const run = { status: "running", ids: [parent.id] };
    h.run = run;
    const result = h.createTeammate(
      parent.id,
      { name: "Child", prompt: "Research", task: "Check the weather" },
      run,
    );
    assert.deepEqual(s.agent(result.agent_id).tools, [weatherPlugin.name]);
  } finally {
    s.db.close();
  }
});

test("plugin DNS lookup is cancellable before any HTTP request", async () => {
  const controller = new AbortController();
  const pending = publicJsonRequest(
    new URL("https://example.com"),
    { method: "GET", headers: {}, signal: controller.signal },
    () => new Promise(() => {}),
  );
  controller.abort(new Error("cancelled DNS"));
  await assert.rejects(pending, /cancelled DNS/);
});
