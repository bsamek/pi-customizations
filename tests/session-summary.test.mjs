import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension, createPiMock, makeContext } = await import("./helpers.mjs");
const { default: extension, parseSummary } = await loadExtension("extensions/session-summary.ts");

function message(role, text) {
  return { type: "message", message: { role, content: [{ type: "text", text }] } };
}

function setup({ branch = [], complete, mode = "tui" } = {}) {
  const mock = createPiMock();
  extension(mock.pi);
  const ctx = makeContext({ branch, complete, mode });
  const titles = [];
  const widgets = [];
  const notices = [];
  ctx.ui.setTitle = (title) => titles.push(title);
  ctx.ui.setWidget = (_key, widget) => widgets.push(widget);
  ctx.ui.notify = (text) => notices.push(text);
  return { ...mock, ctx, titles, widgets, notices };
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
