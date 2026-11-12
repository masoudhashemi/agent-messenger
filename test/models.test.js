import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ModelRegistry, requestCompletion } from "../src/models.js";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";

const base = {
  label: "Test",
  name: "openai/provider-model",
  api_base: "https://models.example/v1",
  api_key_env: "",
  max_tokens: 8192,
};
test("connections preserve exact provider IDs, hide keys and support editing", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const models = new ModelRegistry(db);
    const saved = models.save({ ...base, credential: "secret" });
    assert.equal(saved.name, "openai/provider-model");
    assert.equal(saved.has_credential, true);
    assert.ok(!JSON.stringify(models.list()).includes("secret"));
    assert.equal(models.resolve(saved.id).token, "secret");
    models.save({ ...saved, label: "Renamed" });
    assert.equal(models.resolve(saved.id).token, "secret");
    models.save({ ...saved, credential: "" });
    assert.equal(models.resolve(saved.id).token, "");
    assert.throws(
      () =>
        models.save({
          ...base,
          api_base: "https://user:password@example.com/v1",
        }),
      /credentials/,
    );
    assert.throws(
      () => models.save({ ...base, extra_body: { messages: [] } }),
      /override/,
    );
    assert.throws(() => models.resolve("missing"), /not found/);
    for (const id of [{ id: "bad" }, 42, false, ""])
      assert.throws(() => models.resolve(id), /connection ID/);
  } finally {
    db.close();
  }
});
test("credential names are explicitly configured with no special model key fallback", () => {
  const db = new DatabaseSync(":memory:");
  process.env.TEST_CONNECTION_KEY = "configured-key";
  try {
    const models = new ModelRegistry(db);
    const a = models.save({ ...base, api_key_env: "TEST_CONNECTION_KEY" });
    assert.equal(models.resolve(a.id).token, "configured-key");
    const b = models.save({ ...base, api_key_env: "" });
    assert.equal(models.resolve(b.id).token, "");
    const c = models.save({
      ...base,
      api_key_env: "MISSING_CONNECTION_TEST_KEY",
    });
    assert.throws(() => models.resolve(c.id), /Missing model API key/);
  } finally {
    delete process.env.TEST_CONNECTION_KEY;
    db.close();
  }
});
for (const mode of ["json_schema", "json_object", "text"])
  test("OpenAI-compatible request mode: " + mode, async () => {
    let sent;
    const text = await requestCompletion(
      {
        ...base,
        output_mode: mode,
        token: "secret",
        token_parameter: "max_completion_tokens",
        temperature: null,
        extra_body: { chat_template_kwargs: { enable_thinking: false } },
      },
      [{ role: "user", content: "Return JSON" }],
      { type: "object" },
      undefined,
      async (url, options) => {
        sent = JSON.parse(options.body);
        assert.equal(url, "https://models.example/v1/chat/completions");
        assert.equal(options.headers.Authorization, "Bearer secret");
        assert.equal(options.redirect, "error");
        return new Response(
          JSON.stringify({
            choices: [
              { finish_reason: "stop", message: { content: '{"ok":true}' } },
            ],
          }),
        );
      },
    );
    assert.equal(text, '{"ok":true}');
    assert.equal(sent.model, "openai/provider-model");
    assert.equal(sent.max_completion_tokens, 8192);
    assert.equal(sent.temperature, undefined);
    assert.equal(
      sent.response_format?.type,
      mode === "text" ? undefined : mode,
    );
    assert.equal(sent.extra_body, undefined);
    assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  });
test("provider limits and errors preserve response evidence without leaking credentials", async () => {
  for (const response of [
    { status: 401, body: { error: { message: "secret rejected" } } },
    {
      status: 200,
      body: {
        choices: [
          { finish_reason: "length", message: { content: '{"partial":' } },
        ],
      },
    },
    {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "", reasoning_content: "internal" },
          },
        ],
      },
    },
  ]) {
    await assert.rejects(
      requestCompletion(
        { ...base, token: "secret" },
        [],
        {},
        undefined,
        async () =>
          new Response(JSON.stringify(response.body), {
            status: response.status,
          }),
      ),
      (e) =>
        Boolean(e.responseBody) &&
        !e.responseBody.includes("secret") &&
        !e.message.includes("secret"),
    );
  }
});
test("model selection persists and each run pins its connection configuration", async () => {
  const db = new DatabaseSync(":memory:");
  const store = new Store();
  try {
    const registry = new ModelRegistry(db),
      profile = registry.save(base),
      agent = store.createAgent("A", "Work");
    const h = new Harness(store);
    h.modelRegistry = registry;
    h.selectModel(profile.id);
    // Keep the run open without network access.
    h.loop = () => {};
    h.start([agent.id], "Test", 2);
    assert.equal(h.run.model.name, base.name);
    assert.equal(h.runModel.max_tokens, 8192);
    registry.save({ ...profile, name: "different-model", max_tokens: 16384 });
    assert.equal(h.runModel.name, base.name);
    assert.equal(h.runModel.max_tokens, 8192);
    assert.throws(() => h.selectModel(null), /finish the run/);
    h.stop();
    const restored = new Harness(store);
    assert.equal(restored.modelId, profile.id);
    assert.ok(!JSON.stringify(h.state()).includes('"token":'));
  } finally {
    store.db.close();
    db.close();
  }
});
