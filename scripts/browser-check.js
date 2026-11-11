import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
const testDirectory = mkdtempSync(join(tmpdir(), "relay-browser-"));
const port = 3321;
const server = spawn(process.execPath, ["src/server.js"], {
  env: {
    ...process.env,
    PORT: String(port),
    MODEL_CONFIG: "/nonexistent/relay-browser-test-model.toml",
    PROJECTS_DIR: join(testDirectory, "projects"),
  },
  stdio: "ignore",
});
let ready = false;
for (let i = 0; i < 50; i++) {
  try {
    await fetch(`http://localhost:${port}`);
    ready = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!ready) {
  server.kill();
  throw Error("Test server did not start");
}
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 980 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}`);
  await page.locator("#new-project").click();
  await page.locator("[name=name]").fill("Browser test project");
  await page
    .locator("[name=summary]")
    .fill("An isolated project for browser checks");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#welcome-agent").waitFor();
  assert.equal(await page.locator(".chat-row").count(), 0);
  assert.equal(await page.locator("#demo").count(), 0);
  await page.locator("#sidebar-add-agent").click();
  await page.route(
    "**/api/admin/agents?*",
    (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "Test creation failure" }),
      }),
    { times: 1 },
  );
  await page.locator("[name=name]").fill("Test agent");
  await page
    .locator("[name=prompt]")
    .fill("Work independently and collaborate when useful.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .locator("#modal-error")
    .filter({ hasText: "Test creation failure" })
    .waitFor();
  assert.equal(await page.locator("[name=name]").inputValue(), "Test agent");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.locator("#close").click();
  assert.equal(await page.locator(".chat-row").count(), 0);
  await page.locator("#new-chat").click();
  await page.locator("[name=name]").fill("Research notes");
  await page.locator("[name=summary]").fill("Evidence and open questions");
  await page.locator("[name=kind]").selectOption("self");
  await page.locator("[name=members]").first().check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("heading", { name: "Research notes", exact: true })
    .waitFor();
  await page.locator("#message").fill("Browser smoke test: operator message");
  await page.locator("#compose button").click();
  await page
    .locator(".bubble")
    .filter({ hasText: "Browser smoke test: operator message" })
    .waitFor();
  await page
    .locator(".delivery-error")
    .filter({ hasText: "Could not process request" })
    .waitFor();
  await page.locator("[data-respond]").waitFor();
  await page.locator("#edit-chat").click();
  await page.locator("[name=summary]").fill("Updated summary");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .locator("main")
    .getByText("Updated summary", { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(testDirectory, "desktop-preview.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#sidebar-add-agent").click();
  await page.getByRole("heading", { name: "Create an agent" }).waitFor();
  await page.locator("#cancel").click();
  await page.screenshot({
    path: join(testDirectory, "mobile-preview.png"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert.deepEqual(errors, []);
  const result = await page.evaluate(async () => {
    const unauthorized = await fetch("/api/agent/state");
    const state = await (
      await fetch("/api/admin/state" + location.search)
    ).json();
    return {
      agentStatus: unauthorized.status,
      agents: state.agents.length,
      chats: state.chats.length,
    };
  });
  assert.equal(result.agentStatus, 401);
  assert.equal(result.agents, 1);
  await page.locator("[data-agent-tools]").first().click();
  assert.equal(
    await page.locator("[name=tools][value=web_search]").isChecked(),
    false,
  );
  await page.locator("[name=tools][value=web_search]").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await page.locator("[data-agent-tools]").first().click();
  assert.equal(
    await page.locator("[name=tools][value=web_search]").isChecked(),
    true,
  );
  await page.locator("[name=tools][value=web_search]").uncheck();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.locator("#manage-plugins").click();
  await page.locator("#plugin-weather").click();
  await page
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await page.locator('[data-plugin-edit="plugin_weather"]').waitFor();
  await page.locator('[data-plugin-edit="plugin_weather"]').click();
  await page.locator("[name=auth_type]").selectOption("bearer");
  await page.locator("[name=credential]").fill("browser-test-secret");
  await page.getByRole("button", { name: "Save plugin", exact: true }).click();
  const pluginPayload = await page.evaluate(
    async () =>
      await (await fetch("/api/admin/plugins" + location.search)).json(),
  );
  assert.equal(pluginPayload[0].has_credential, true);
  assert.ok(!JSON.stringify(pluginPayload).includes("browser-test-secret"));
  const pluginDownload = page.waitForEvent("download");
  await page.locator('[data-plugin-export="plugin_weather"]').click();
  let exported = "";
  for await (const chunk of await (await pluginDownload).createReadStream())
    exported += chunk;
  assert.ok(!exported.includes("browser-test-secret"));
  assert.equal(JSON.parse(exported).name, "plugin_weather");
  await page.locator("#plugins-close").click();
  await page.locator("[data-agent-tools]").first().click();
  await page.locator("[name=tools][value=plugin_weather]").check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.reload();
  await page.locator("[data-agent-tools]").first().click();
  assert.equal(
    await page.locator("[name=tools][value=plugin_weather]").isChecked(),
    true,
  );
  await page.locator("#cancel").click();
  await page.locator("#manage-plugins").click();
  await page.route(
    "**/api/admin/plugins/test?*",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ data: { temperature: 12 } }),
      }),
    { times: 1 },
  );
  await page.locator('[data-plugin-test="plugin_weather"]').click();
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  await page
    .locator("#plugin-test-output")
    .filter({ hasText: "temperature" })
    .waitFor();
  await page.locator("#cancel").click();
  await page.locator("#manage-plugins").click();
  page.once("dialog", (d) => d.accept());
  await page.locator('[data-plugin-remove="plugin_weather"]').click();
  await page
    .locator('[data-plugin-edit="plugin_weather"]')
    .waitFor({ state: "detached" });
  await page
    .locator("#plugin-import")
    .setInputFiles({
      name: "weather.json",
      mimeType: "application/json",
      buffer: Buffer.from(exported),
    });
  await page
    .getByRole("button", { name: "Install plugin", exact: true })
    .click();
  await page.locator('[data-plugin-edit="plugin_weather"]').waitFor();
  assert.equal(
    await page.evaluate(async () => {
      const s = await (
        await fetch("/api/admin/state" + location.search)
      ).json();
      return s.agents[0].tools.includes("plugin_weather");
    }),
    false,
  );
  await page.locator("#plugins-close").click();

  assert.equal(await page.locator("#allow-agent-creation").isChecked(), false);
  await page.locator("#allow-agent-creation").check();
  await page.waitForFunction(
    () => document.querySelector("#allow-agent-creation")?.checked,
  );
  await page.locator("#max-new-agents").fill("2");
  await page.locator("#max-new-agents").dispatchEvent("change");
  await page.waitForFunction(async () => {
    const s = await (await fetch("/api/admin/state" + location.search)).json();
    return s.settings?.allow_agent_creation && s.settings.max_new_agents === 2;
  });
  await page.reload();
  await page.locator("#allow-agent-creation").waitFor();
  assert.equal(await page.locator("#allow-agent-creation").isChecked(), true);
  assert.equal(await page.locator("#max-new-agents").inputValue(), "2");
  await page.locator("#code-workspace").click();
  assert.equal(await page.locator("#use-uv").isChecked(), false);
  await page.locator("#use-uv").check();
  await page.waitForFunction(async () => {
    const s = await (await fetch("/api/admin/state" + location.search)).json();
    return s.coding.environment.use_uv;
  });
  assert.equal(
    await page.locator('[data-uv-action="sync"]').isEnabled(),
    false,
  );
  if (process.env.BROWSER_TEST_PYTHON === "1") {
    await page.locator('[data-uv-action="venv"]').click();
    await page
      .locator("#uv-status")
      .filter({ hasText: "Completed" })
      .waitFor({ timeout: 30000 });
    await page.locator("#uv-command").fill('python -c "print(12345)"');
    await page.locator("#uv-run-command").click();
    await page
      .locator(".execution pre")
      .filter({ hasText: "12345" })
      .waitFor({ timeout: 30000 });
  }
  await page.locator("#use-uv").uncheck();
  await page.waitForFunction(async () => {
    const s = await (await fetch("/api/admin/state" + location.search)).json();
    return !s.coding.environment.use_uv;
  });

  page.once("dialog", (d) => d.accept("src/empty"));
  await page.locator("#new-folder").click();
  await page.locator('[data-folder="src/empty"]').waitFor();
  await page.locator("#new-file").click();
  assert.equal(await page.locator("#code-path").inputValue(), "src/empty/");
  await page.locator("#code-path").fill("src/empty/nested.py");
  await page.locator("#code-content").fill("value = 42\n");
  await page.locator("#save-code").click();
  await page.locator('[data-file="src/empty/nested.py"]').waitFor();
  const folder = await page.locator("#workspace-path").textContent();
  assert.equal(
    readFileSync(folder + "/src/empty/nested.py", "utf8"),
    "value = 42\n",
  );
  await page
    .locator('[data-change-path="src/empty/nested.py"]')
    .first()
    .waitFor();
  writeFileSync(folder + "/external.txt", "external proof\n");
  await page.locator('[data-file="external.txt"]').waitFor();
  await page
    .locator("#workspace-history")
    .getByText("External editor", { exact: true })
    .first()
    .waitFor();
  rmSync(folder + "/external.txt");
  await page
    .locator('[data-file="external.txt"]')
    .waitFor({ state: "detached" });
  await page
    .locator('[data-change-path="external.txt"][data-change-revision="2"]')
    .click();
  await page
    .locator("#code-diff")
    .getByText("external proof", { exact: true })
    .waitFor();
  await page.locator('[data-file="src/empty/nested.py"]').click();

  await page.locator('[data-folder="src/empty"] > summary').click();
  assert.equal(
    await page.locator('[data-file="src/empty/nested.py"]').isVisible(),
    false,
  );
  await page.locator('[data-folder="src/empty"] > summary').click();
  await page.locator("#explorer-root").click();
  await page.locator("#new-file").click();
  await page.locator("#code-path").fill("hello.py");
  await page.locator("#code-content").fill('print("hello from the editor")\n');
  await page.locator("#save-code").click();
  await page
    .locator("#code-revision")
    .filter({ hasText: "Revision 1" })
    .waitFor();
  await page.locator('[data-file="hello.py"]').waitFor();
  await page.evaluate(async () => {
    const scope = location.search;
    const agent = await (
      await fetch("/api/admin/agents" + scope, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Reviewer",
          prompt: "Review shared code",
        }),
      })
    ).json();
    const response = await fetch("/api/agent/files/edit" + scope, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + agent.token,
      },
      body: JSON.stringify({
        path: "hello.py",
        find: "hello from the editor",
        replace: "hello from the reviewer",
        expected_revision: 1,
      }),
    });
    if (!response.ok) throw Error("Agent edit failed");
  });
  await page.locator("#latest-code").waitFor();
  await page.locator("#latest-code").click();
  await page
    .locator("#code-revision")
    .filter({ hasText: "Revision 2" })
    .waitFor();
  await page.locator('[data-code-tab="changes"]').click();
  await page
    .locator(".diff-line.added")
    .filter({ hasText: "hello from the reviewer" })
    .waitFor();
  await page
    .locator(".diff-line.removed")
    .filter({ hasText: "hello from the editor" })
    .waitFor();
  assert.match(
    await page.locator("#changes-summary").textContent(),
    /Reviewer/,
  );
  await page.locator('[data-code-tab="history"]').click();
  await page.locator('[data-revision="1"]').click();
  await page
    .locator("#code-revision")
    .filter({ hasText: "Revision 1" })
    .waitFor();
  assert.equal(await page.locator("#save-code").isDisabled(), true);
  assert.equal(await page.locator("#run-python").isDisabled(), true);
  await page.locator('[data-code-tab="source"]').click();
  assert.equal(
    await page.locator("#code-content").inputValue(),
    'print("hello from the editor")\n',
  );
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download-code").click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), "hello.py");
  let downloaded = "";
  for await (const chunk of await download.createReadStream())
    downloaded += chunk;
  assert.equal(downloaded, 'print("hello from the editor")\n');
  await page.locator("#latest-code").click();
  await page
    .locator("#code-revision")
    .filter({ hasText: "Revision 2" })
    .waitFor();
  assert.equal(await page.locator("#save-code").isEnabled(), true);
  if (process.env.BROWSER_TEST_PYTHON === "1") {
    await page.locator("#run-python").click();
    await page
      .locator(".execution .state")
      .filter({ hasText: "succeeded" })
      .first()
      .waitFor({ timeout: 30000 });
    await page
      .locator(".execution pre")
      .filter({ hasText: "hello from the reviewer" })
      .waitFor();
  }
  await page.screenshot({
    path: join(testDirectory, "code-workspace-preview.png"),
    fullPage: true,
  });
  await page.locator("#close-code").click();
  // Agent API edits also create a self-chat diff. Its link remains pinned to v2.
  await page.locator(".chat-row").filter({ hasText: "File changes" }).click();
  const card = page.locator(
    '.chat-file-diff[data-diff-path="hello.py"][data-diff-revision="2"]',
  );
  await card
    .locator(".diff-line.added")
    .filter({ hasText: "hello from the reviewer" })
    .waitFor();
  await card
    .locator(".diff-line.removed")
    .filter({ hasText: "hello from the editor" })
    .waitFor();
  await page.evaluate(async () => {
    const response = await fetch("/api/admin/files/write" + location.search, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "hello.py",
        content: 'print("later reviewer revision")\n',
        expected_revision: 2,
      }),
    });
    if (!response.ok) throw Error("Later edit failed");
  });
  await card.locator("[data-open-diff]").click();
  await page
    .locator("#code-revision")
    .filter({ hasText: "Revision 2" })
    .waitFor();
  assert.equal(await page.locator("#changes-panel").isVisible(), true);
  assert.equal(await page.locator("#save-code").isDisabled(), true);
  assert.match(
    await page.locator("#code-diff").textContent(),
    /hello from the reviewer/,
  );
  await page.locator("#close-code").click();
  await page.locator("#search-knowledge").click();
  await page.locator("#knowledge-query").fill("Browser smoke");
  await page.locator("#knowledge-form button").click();
  await page
    .locator(".knowledge-hit")
    .filter({ hasText: "Browser smoke test" })
    .waitFor();
  await page.locator("[data-source]").first().click();
  await page
    .locator(".source-content")
    .filter({ hasText: "Browser smoke test" })
    .waitFor();
  await page.locator("#close-search").click();
  const retrievalChecks = await page.evaluate(async () => {
    const scope = location.search;
    const headers = { "Content-Type": "application/json" };
    const adminState = await (await fetch("/api/admin/state" + scope)).json();
    const agent = await (
      await fetch("/api/admin/agents" + scope, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Isolated searcher",
          prompt: "Search only allowed records",
        }),
      })
    ).json();
    const auth = { ...headers, Authorization: "Bearer " + agent.token };
    const envChange = await fetch("/api/agent/environment" + scope, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ use_uv: true, allow_package_install: true }),
    });
    if (envChange.status !== 403)
      throw new Error("Agent was permitted to change environment settings");

    const forbiddenSetting = await fetch("/api/agent/settings" + scope, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ allow_agent_creation: false, max_new_agents: 10 }),
    });
    if (forbiddenSetting.ok) throw new Error("Agent changed operator settings");
    const unchanged = await (await fetch("/api/admin/state" + scope)).json();
    if (
      !unchanged.settings.allow_agent_creation ||
      unchanged.settings.max_new_agents !== 2
    )
      throw new Error("Agent mutated settings");
    const request = async (body) => {
      const response = await fetch("/api/agent/retrieve" + scope, {
        method: "POST",
        headers: auth,
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const hidden = adminState.chats.find((c) => c.kind === "self").messages[0];
    const search = await request({
      type: "search_messages",
      query: "Browser smoke",
      agent_id: adminState.agents[0].id,
    });
    const read = await request({ type: "read_message", message_id: hidden.id });
    const files = await request({ type: "search_files", query: "reviewer" });
    const state = await (
      await fetch("/api/agent/state" + scope, { headers: auth })
    ).json();
    const other = await (
      await fetch("/api/admin/projects", {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Other project" }),
      })
    ).json();
    const cross = await fetch("/api/agent/retrieve?project=" + other.id, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "search_files", query: "reviewer" }),
    });
    return {
      search: search.body.results,
      read: read.status,
      files: files.body.results.length,
      hasMessages: JSON.stringify(state).includes("Browser smoke"),
      cross: cross.status,
    };
  });
  assert.deepEqual(retrievalChecks, {
    search: [],
    read: 403,
    files: 1,
    hasMessages: false,
    cross: 401,
  });
  const projectUrl = page.url();
  await page.goto(`http://localhost:${port}`);
  await page
    .getByRole("heading", { name: "Browser test project", exact: true })
    .waitFor();
  await page.screenshot({
    path: join(testDirectory, "projects-preview.png"),
    fullPage: true,
  });
  await page
    .locator(".project-card")
    .filter({ hasText: "Browser test project" })
    .getByRole("link", { name: "Review" })
    .click();
  assert.equal(page.url(), projectUrl);
  await page
    .getByRole("heading", { name: "Research notes", exact: true })
    .waitFor();
  await page.goto(`http://localhost:${port}`);
  const projectCard = page
    .locator(".project-card")
    .filter({ hasText: "Browser test project" });
  await projectCard.locator("[data-delete-project]").click();
  assert.equal(
    await page.locator("[name=delete_artifacts]").isChecked(),
    false,
  );
  await page.locator("#cancel").click();
  assert.ok(existsSync(folder));
  await projectCard.locator("[data-delete-project]").click();
  await page.locator("[name=confirm_name]").fill("wrong name");
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await page
    .locator("#modal-error")
    .filter({ hasText: "exact project name" })
    .waitFor();
  assert.ok(existsSync(folder));
  await page.locator("[name=confirm_name]").fill("Browser test project");
  await page.locator("[name=delete_artifacts]").check();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await projectCard.waitFor({ state: "detached" });
  assert.equal(existsSync(folder), false);
  await page
    .locator(".project-card")
    .filter({ hasText: "Other project" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log("Browser checks passed:", result);
} finally {
  await browser.close();
  const exited = once(server, "exit");
  server.kill();
  await exited;
  rmSync(testDirectory, { recursive: true, force: true });
}
