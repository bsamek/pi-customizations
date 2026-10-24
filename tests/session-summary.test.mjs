import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension, createPiMock, makeContext } = await import("./helpers.mjs");
const { default: extension, parseSummary } = await loadExtension("extensions/session-summary.ts");

function message(role, text) {
  return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

function setup({ branch = [], complete, mode = "tui" } = {}) {
  const mock = createPiMock();
  const executions = [];
  mock.pi.exec = async (...args) => {
    executions.push(args);
    return { code: 0, stdout: "", stderr: "", killed: false };
  };
  extension(mock.pi);
  const ctx = makeContext({ branch, complete, mode });
  const titles = [];
  const widgets = [];
  const notices = [];
  ctx.ui.setTitle = (title) => titles.push(title);
  ctx.ui.setWidget = (_key, widget) => widgets.push(widget);
  ctx.ui.notify = (text) => notices.push(text);
  return { ...mock, ctx, titles, widgets, notices, executions };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const summaryReply = (title = "Fix OAuth", recap = "Fixed token refresh.") => async () => ({
  content: [{ type: "text", text: `Title: ${title}\nRecap: ${recap}` }],
});

test("session start applies the generated title", async () => {
  const s = setup({
    branch: [message("user", "Fix OAuth"), message("assistant", "Done")],
    complete: summaryReply(),
  });
  await s.events.get("session_start")[0]({}, s.ctx);
  await flush();
  assert.equal(s.titles.at(-1), "π - Fix OAuth");
});

test("one completed user turn updates the title and schedules a recap after three idle minutes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup({
    branch: [message("user", "Fix OAuth"), message("assistant", "Done")],
    complete: summaryReply(),
    mode: "rpc",
  });

  await s.events.get("agent_settled")[0]({}, s.ctx);
  await flush();
  assert.equal(s.titles.at(-1), "π - Fix OAuth");
  assert.equal(s.widgets.filter(Boolean).length, 0);

  t.mock.timers.tick(3 * 60 * 1000);
  assert.deepEqual(s.widgets.filter(Boolean).at(-1), ["recap: Fixed token refresh."]);
});

test("no user turns means no summary call and no recap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const s = setup({
    branch: [message("assistant", "Only a reply")],
    complete: async () => {
      calls++;
      return summaryReply()();
    },
  });

  await s.events.get("agent_settled")[0]({}, s.ctx);
  await flush();
  t.mock.timers.tick(3 * 60 * 1000);
  assert.equal(calls, 0);
  assert.equal(s.widgets.filter(Boolean).length, 0);
});

test("automatic recaps can be disabled without disabling title updates", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup({
    branch: [message("user", "Fix OAuth"), message("assistant", "Done")],
    complete: summaryReply(),
  });

  await s.commands.get("recap").handler("off", s.ctx);
  await s.events.get("agent_settled")[0]({}, s.ctx);
  await flush();
  assert.equal(s.titles.at(-1), "π - Fix OAuth");
  t.mock.timers.tick(3 * 60 * 1000);
  assert.equal(s.widgets.filter(Boolean).length, 0);
});

test("submitting another prompt cancels a pending automatic recap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup({
    branch: [message("user", "Fix OAuth"), message("assistant", "Done")],
    complete: summaryReply(),
    mode: "rpc",
  });

  await s.events.get("agent_settled")[0]({}, s.ctx);
  await flush();
  await s.events.get("input")[0]({ source: "user" }, s.ctx);
  t.mock.timers.tick(3 * 60 * 1000);
  assert.notDeepEqual(s.widgets.filter(Boolean).at(-1), ["recap: Fixed token refresh."]);
});

test("on-demand /recap with no conversation reports that nothing is available", async () => {
  const s = setup({ branch: [] });
  await s.commands.get("recap").handler("", s.ctx);
  assert.match(s.notices.at(-1), /No recap available/);
});

test("on-demand /recap shows the recap immediately in RPC mode", async () => {
  const s = setup({
    branch: [message("user", "Fix OAuth"), message("assistant", "Done")],
    complete: summaryReply(),
    mode: "rpc",
  });
  await s.commands.get("recap").handler("", s.ctx);
  assert.deepEqual(s.widgets.filter(Boolean).at(-1), ["recap: Fixed token refresh."]);
});

test("/session-title can set a manual title", async () => {
  const s = setup();
  await s.commands.get("session-title").handler("My manual title.", s.ctx);
  assert.equal(s.titles.at(-1), "π - My manual title");
});

function herdrEnv(t, overrides = {}) {
  const values = {
    TERM_PROGRAM: "herdr", HERDR_ENV: "1", HERDR_TAB_ID: "w4:t1",
    HERDR_BIN_PATH: "/fake/herdr", ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test("Herdr mirrors generated, manual, and shutdown titles using argument-safe CLI calls", async (t) => {
  herdrEnv(t);
  const s = setup({ branch: [message("user", "Fix OAuth")], complete: summaryReply() });
  await s.events.get("session_start")[0]({}, s.ctx);
  await flush();
  assert.equal(s.executions.at(-1)[1].at(-1), "π - Fix OAuth");
  await s.commands.get("session-title").handler("Fix $(echo unsafe)", s.ctx);
  await flush();
  assert.deepEqual(s.executions.at(-1), [
    "/fake/herdr", ["tab", "rename", "w4:t1", "π - Fix $(echo unsafe)"], { timeout: 2000 },
  ]);
  await s.events.get("session_shutdown")[0]({}, s.ctx);
  assert.equal(s.executions.at(-1)[1].at(-1), s.titles.at(-1));
});

for (const scenario of [
  { name: "outside Herdr", env: { TERM_PROGRAM: "ghostty", HERDR_ENV: undefined } },
  { name: "missing tab ID", env: { HERDR_TAB_ID: undefined } },
  { name: "RPC", mode: "rpc" },
  { name: "print", mode: "print" },
]) {
  test(`does not rename tabs: ${scenario.name}`, async (t) => {
    herdrEnv(t, scenario.env);
    const s = setup({ mode: scenario.mode });
    await s.commands.get("session-title").handler("Manual title", s.ctx);
    await flush();
    assert.deepEqual(s.executions, []);
  });
}

test("Herdr renames are serialized and recover silently from CLI failures", async (t) => {
  herdrEnv(t, { HERDR_BIN_PATH: undefined });
  const s = setup();
  let rejectFirst;
  const calls = [];
  s.pi.exec = async (binary, args) => {
    calls.push([binary, args.at(-1)]);
    if (calls.length === 1) await new Promise((_resolve, reject) => { rejectFirst = reject; });
    return { code: 0 };
  };
  await s.commands.get("session-title").handler("First", s.ctx);
  await s.commands.get("session-title").handler("Second", s.ctx);
  await flush();
  assert.deepEqual(calls, [["herdr", "π - First"]]);
  rejectFirst(new Error("CLI unavailable"));
  await flush();
  assert.deepEqual(calls, [["herdr", "π - First"], ["herdr", "π - Second"]]);
  assert.equal(s.notices.some((notice) => notice.includes("unavailable")), false);
});

for (const scenario of [
  { name: "OpenAI only", available: ["openai"], active: "openai", expected: "openai" },
  { name: "all authenticated: prefer active OpenAI", active: "openai", expected: "openai" },
  { name: "Codex unavailable: fall back to OpenAI", available: ["openai"], active: "openai-codex", expected: "openai" },
  { name: "OpenAI unauthenticated: fall back to Codex", available: ["openai", "openai-codex"], active: "openai", unauthenticated: "openai", expected: "openai-codex" },
  { name: "work: Copilot only", available: ["github-copilot"], active: "github-copilot", expected: "github-copilot" },
  { name: "home: Codex only", available: ["openai-codex"], active: "openai-codex", expected: "openai-codex" },
  { name: "both authenticated: prefer active Codex", active: "openai-codex", expected: "openai-codex" },
  { name: "both authenticated: prefer active Copilot", active: "github-copilot", expected: "github-copilot" },
  { name: "unrelated active provider: prefer Copilot", active: "anthropic", expected: "github-copilot" },
  { name: "unauthenticated Copilot: fall back to Codex", active: "github-copilot", unauthenticated: "github-copilot", expected: "openai-codex" },
  { name: "unauthenticated Codex: fall back to Copilot", active: "openai-codex", unauthenticated: "openai-codex", expected: "github-copilot" },
]) {
  test(`summary provider selection: ${scenario.name}`, async () => {
    const calls = [];
    const s = setup({
      branch: [message("user", "Fix OAuth")],
      complete: async (model) => {
        calls.push(model.provider);
        return summaryReply()();
      },
    });
    s.ctx.model = { provider: scenario.active };
    s.ctx.modelRegistry.find = (provider, id) =>
      (scenario.available ?? ["github-copilot", "openai-codex", "openai"]).includes(provider)
        ? { provider, id }
        : undefined;
    s.ctx.modelRegistry.hasConfiguredAuth = (model) => model.provider !== scenario.unauthenticated;

    await s.commands.get("recap").handler("", s.ctx);
    assert.deepEqual(calls, [scenario.expected]);
    assert.deepEqual(s.notices, []);
    assert.equal(s.titles.at(-1), "π - Fix OAuth");
  });
}

for (const missing of [true, false]) {
  test(`no provider ${missing ? "available" : "authenticated"}: warn once and recheck later`, async () => {
    let calls = 0;
    const s = setup({
      branch: [message("user", "Fix OAuth")],
      complete: async () => {
        calls++;
        return summaryReply()();
      },
    });
    s.ctx.modelRegistry.find = (provider, id) => missing ? undefined : { provider, id };
    s.ctx.modelRegistry.hasConfiguredAuth = () => false;
    await s.events.get("session_start")[0]({}, s.ctx);
    await flush();
    await s.events.get("agent_settled")[0]({}, s.ctx);
    await flush();
    assert.equal(calls, 0);
    assert.equal(s.notices.length, 1);
    assert.match(s.notices[0], /github-copilot or openai-codex or openai/);

    s.ctx.modelRegistry.find = (provider, id) => provider === "openai-codex" ? { provider, id } : undefined;
    s.ctx.modelRegistry.hasConfiguredAuth = () => true;
    await s.commands.get("recap").handler("", s.ctx);
    assert.equal(calls, 1);
    assert.equal(s.titles.at(-1), "π - Fix OAuth");
  });
}

test("parseSummary accepts labeled and unlabeled responses", () => {
  assert.deepEqual(parseSummary("Title: Fix OAuth\nRecap: Fixed token refresh."), {
    title: "Fix OAuth",
    recap: "Fixed token refresh.",
  });
  assert.deepEqual(parseSummary("Fix OAuth\nFixed token refresh.\nStill testing."), {
    title: "Fix OAuth",
    recap: "Fixed token refresh. Still testing.",
  });
  assert.deepEqual(parseSummary("Recap: Just a recap."), { recap: "Just a recap." });
  assert.deepEqual(parseSummary("   "), {});
});
