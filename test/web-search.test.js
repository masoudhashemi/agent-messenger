import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Harness } from "../src/harness.js";
import { WebSearch } from "../src/web-search.js";
import { renderMessage } from "../public/format.js";
const response = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });

test("web search enforces per-agent permission, validates queries and hides keys", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Research");
    let calls = 0;
    const search = new WebSearch({
      env: { BRAVE_SEARCH_API_KEY: "secret-key" },
      fetcher: async (url, options) => {
        calls++;
        assert.equal(url.hostname, "api.search.brave.com");
        assert.equal(options.headers["X-Subscription-Token"], "secret-key");
        assert.equal(options.redirect, "error");
        return response({
          web: {
            results: [
              {
                title: "Title",
                url: "https://example.com",
                description: "secret-key " + "a".repeat(1000),
              },
              { title: "Unsafe", url: "javascript:alert(1)" },
            ],
          },
        });
      },
    });
    await assert.rejects(
      search.execute(s, a.id, { query: "query" }),
      /not enabled/,
    );
    assert.equal(calls, 0);
    s.setAgentTools(a.id, ["web_search"]);
    await assert.rejects(
      search.execute(s, a.id, { query: "" }),
      /Search query/,
    );
    await assert.rejects(
      search.execute(s, a.id, { query: "query", limit: 100 }),
      /limit/,
    );
    const result = await search.execute(s, a.id, { query: "query" });
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].snippet, "[redacted] " + "a".repeat(1000));
    assert.ok(!JSON.stringify(result).includes("secret-key"));
    assert.ok(!JSON.stringify(search.status()).includes("secret-key"));
    s.setAgentTools(a.id, []);
    await assert.rejects(
      search.execute(s, a.id, { query: "query" }),
      /not enabled/,
    );
    assert.throws(
      () => s.setAgentTools(a.id, ["shell"]),
      /Supported optional tools/,
    );
  } finally {
    s.db.close();
  }
});

test("Tavily normalization, missing credentials and provider errors", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("A", "Research", ["web_search"]);
    await assert.rejects(
      new WebSearch({ env: {} }).execute(s, a.id, { query: "query" }),
      /not configured/,
    );
    const tavily = new WebSearch({
      env: { WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "key" },
      fetcher: async (url, opts) => {
        assert.equal(url.href, "https://api.tavily.com/search");
        assert.equal(opts.headers.Authorization, "Bearer key");
        assert.equal(JSON.parse(opts.body).include_raw_content, false);
        return response({
          results: [
            { title: "Source", url: "https://example.com", content: "Snippet" },
          ],
        });
      },
    });
    assert.equal(
      (await tavily.execute(s, a.id, { query: "query" })).results[0].snippet,
      "Snippet",
    );
    tavily.fetcher = async () =>
      new Response("private provider details", { status: 429 });
    await assert.rejects(
      tavily.execute(s, a.id, { query: "query" }),
      /^Error: Web search provider returned HTTP 429$/,
    );
    tavily.fetcher = async () => {
      throw Error("sensitive transport details");
    };
    await assert.rejects(
      tavily.execute(s, a.id, { query: "query" }),
      /^Error: Web search request failed$/,
    );
    tavily.fetcher = async () => new Response("x".repeat(1000001));
    await assert.rejects(
      tavily.execute(s, a.id, { query: "query" }),
      /size limit/,
    );
  } finally {
    s.db.close();
  }
});

test("harness delivers search results on a subsequent turn and saves clickable sources privately", async () => {
  const s = new Store();
  try {
    const a = s.createAgent("Researcher", "Research", ["web_search"]);
    let turns = 0;
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        turns++;
        const context = JSON.parse(messages[1].content);
        assert.deepEqual(context.you.tools, ["web_search"]);
        if (turns === 2)
          assert.ok(
            JSON.stringify(context.previous_action_results).includes(
              "Evidence",
            ),
          );
        return JSON.stringify({
          working_note: { name: "Research", body: "Inspect sources" },
          actions:
            turns === 1
              ? [
                  { type: "web_search", query: "query" },
                  {
                    type: "finish",
                    summary:
                      "Completed the fixture task; see the delivered result and evidence.",
                  },
                ]
              : turns === 2
                ? [
                    {
                      type: "read_source",
                      source_id:
                        context.previous_action_results[0].sources.results[0]
                          .source_id,
                    },
                  ]
                : [
                    { type: "reply", body: "Evidence: https://example.com" },
                    {
                      type: "finish",
                      summary:
                        "Completed the fixture task; see the delivered result and evidence.",
                    },
                  ],
        });
      },
    );
    h.webSearch = new WebSearch({
      env: { BRAVE_SEARCH_API_KEY: "key" },
      fetcher: async () =>
        response({
          web: {
            results: [
              {
                title: "Evidence",
                url: "https://example.com",
                description: "Evidence snippet",
              },
            ],
          },
        }),
    });
    h.start([a.id], "Research", 3);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    assert.equal(turns, 3);
    const message = s
      .snapshot()
      .chats.flatMap((c) => c.messages)
      .find((m) => m.body.startsWith("Web search\n"));
    assert.ok(message);
    assert.match(renderMessage(message.body), /href="https:\/\/example.com\//);
    const xss = renderMessage(
      "Web search\n" +
        JSON.stringify({
          query: "<img>",
          results: [
            { title: "<script>", url: "https://example.com", snippet: "<img>" },
            { url: "javascript:alert(1)" },
          ],
        }),
    );
    assert.ok(!xss.includes("<img>"));
    assert.ok(!xss.includes("javascript:"));
  } finally {
    s.db.close();
  }
});

test("agents cannot grant a child web search unless they have it themselves", () => {
  const s = new Store();
  try {
    const a = s.createAgent("Parent", "Coordinate");
    const h = new Harness(s);
    h.configure({ allow_agent_creation: true, max_new_agents: 2 });
    const run = { status: "running", ids: [a.id] };
    h.run = run;
    const action = {
      name: "Child",
      prompt: "Research",
      task: "Find sources",
      tools: ["web_search"],
    };
    assert.throws(() => h.createTeammate(a.id, action, run), /Cannot delegate/);
    assert.equal(s.agents().length, 1);
    s.setAgentTools(a.id, ["web_search"]);
    h.createTeammate(a.id, action, run);
    assert.deepEqual(s.agents().find((a) => a.name === "Child").tools, [
      "web_search",
    ]);
  } finally {
    s.db.close();
  }
});

test("automatic teammates inherit tools when omitted, can search, and can explicitly opt out", async () => {
  const s = new Store();
  try {
    const parent = s.createAgent("Parent", "Coordinate", ["web_search"]);
    let childTurns = 0;
    const h = new Harness(
      s,
      () => {},
      async (messages) => {
        const context = JSON.parse(messages[1].content);
        const actions =
          context.you.id === parent.id
            ? [
                {
                  type: "create_agent",
                  name: "Researcher",
                  prompt: "Research with sources",
                  task: "Search for official Python documentation",
                },
                {
                  type: "finish",
                  summary:
                    "Completed the fixture task; see the delivered result and evidence.",
                },
              ]
            : ++childTurns === 1
              ? [
                  { type: "web_search", query: "Python documentation" },
                  {
                    type: "finish",
                    summary:
                      "Completed the fixture task; see the delivered result and evidence.",
                  },
                ]
              : [
                  {
                    type: "finish",
                    summary:
                      "Completed the fixture task; see the delivered result and evidence.",
                  },
                ];
        return JSON.stringify({
          working_note: { name: "Work", body: "Complete the research task" },
          actions,
        });
      },
    );
    h.configure({ allow_agent_creation: true, max_new_agents: 2 });
    let searchedAs;
    h.webSearch = new WebSearch({
      env: { TAVILY_API_KEY: "key" },
      fetcher: async () =>
        response({
          results: [
            {
              title: "Python",
              url: "https://docs.python.org",
              content: "Documentation",
            },
          ],
        }),
    });
    const execute = h.webSearch.execute.bind(h.webSearch);
    h.webSearch.execute = async (store, actor, ...args) => {
      searchedAs = actor;
      return execute(store, actor, ...args);
    };
    h.start([parent.id], "Delegate research", 6);
    while (h.run.status === "running")
      await new Promise((r) => setTimeout(r, 5));
    const child = s.agents().find((a) => a.name === "Researcher");
    assert.deepEqual(child.tools, ["web_search"]);
    assert.equal(searchedAs, child.id);
    assert.ok(
      s
        .snapshot(child.id)
        .chats.filter((c) => c.kind === "self")
        .flatMap((c) => c.messages)
        .some((m) => m.body.startsWith("Web search\n")),
    );
    const run = { status: "running", ids: [parent.id] };
    h.run = run;
    const noTools = h.createTeammate(
      parent.id,
      { name: "Offline", prompt: "Write", task: "Write notes", tools: [] },
      run,
    );
    assert.deepEqual(s.agent(noTools.agent_id).tools, []);
    assert.throws(
      () =>
        h.createTeammate(
          parent.id,
          { name: "Bad", prompt: "Write", task: "Write", tools: null },
          run,
        ),
      /Supported optional tools/,
    );
  } finally {
    s.db.close();
  }
});
