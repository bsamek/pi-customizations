import assert from "node:assert/strict";
import { test } from "node:test";

// Act as a fake child pi when spawned by the extension under test.
if (process.argv.includes("--mode")) {
  const args = process.argv.slice(2);
  assert.ok(args.includes("--no-extensions"));
  assert.ok(args.includes("--no-session"));
  assert.ok(!args.includes("--no-skills"));
  assert.ok(!args.includes("--no-prompt-templates"));

  const tools = args[args.indexOf("--tools") + 1];
  assert.equal(tools, "read,grep,find,ls,bash");

  const guard = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(guard, /read-only subagent/);
  assert.match(guard, /Do not modify the repository/);
  assert.ok(!guard.startsWith("/"), "guard should be inline text, not a temp file");

  assert.match(args[args.indexOf("--model") + 1], /^github-copilot\//);

  const task = args.at(-1);
  if (task === "Task: hang") await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixture complete" }],
        stopReason: task === "Task: fail" ? "error" : "stop",
        errorMessage: task === "Task: fail" ? "fixture error" : undefined,
      },
    }),
  );
} else {
  const { loadExtension, createPiMock, makeContext } = await import("./helpers.mjs");
  const { default: extension } = await loadExtension("extensions/subagent/index.ts");

  function setup(models) {
    const mock = createPiMock();
    extension(mock.pi);
    const ctx = makeContext();
    if (models) {
      ctx.scopedModels = models.map((model) => ({ model }));
      ctx.modelRegistry.getAvailable = () => models;
    }
    return { ...mock, ctx, tool: mock.tools.get("subagent") };
  }

  const luna = { provider: "github-copilot", id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true };
  const other = { provider: "github-copilot", id: "other", name: "Other Model", reasoning: false };

  const run = (s, tasks, signal) => s.tool.execute("", { tasks }, signal, undefined, s.ctx);

  test("falls back to all available models when no scoped models are configured", async () => {
    const s = setup();
    s.ctx.scopedModels = [];
    const result = await run(s, [{ model: "GPT-6 Luna", task: "fixture" }]);
    assert.equal(result.details.results[0].resolvedModel, "github-copilot/gpt-6-luna");
  });

  test("single task runs read-only and returns output", async () => {
    const s = setup();
    const result = await run(s, [{ model: "gpt-6-luna", task: "fixture" }]);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /fixture complete/);
    assert.equal(result.details.results.length, 1);
    assert.equal(result.details.results[0].resolvedModel, "github-copilot/gpt-6-luna");
  });

  test("repeating a task across models fans it out", async () => {
    const s = setup([luna, other]);
    const result = await run(s, [
      { model: "gpt-6-luna", task: "fixture" },
      { model: "other", task: "fixture" },
    ]);
    assert.match(result.content[0].text, /2\/2 subagents succeeded/);
    assert.deepEqual(
      result.details.results.map((r) => r.resolvedModel),
      ["github-copilot/gpt-6-luna", "github-copilot/other"],
    );
  });

  test("models accept display names, bare ids, and canonical references", async () => {
    const s = setup([luna, other]);
    for (const reference of ["GPT-6 Luna", "gpt-6-luna", "github-copilot/gpt-6-luna"]) {
      const result = await run(s, [{ model: reference, task: "fixture" }]);
      assert.equal(result.details.results[0].resolvedModel, "github-copilot/gpt-6-luna");
    }
  });

  test("empty, oversized, ambiguous, and unavailable batches fail before dispatch", async () => {
    const s = setup();
    assert.match((await run(s, [])).content[0].text, /at least one task/);

    const tooMany = Array.from({ length: 9 }, () => ({ model: "gpt-6-luna", task: "fixture" }));
    assert.match((await run(s, tooMany)).content[0].text, /Too many subagents/);

    const twin = { ...luna, id: "one", name: "Twin" };
    const twinToo = { ...luna, id: "two", name: "Twin" };
    const ambiguous = setup([luna, twin, twinToo]);
    assert.match((await run(ambiguous, [{ model: "Twin", task: "fixture" }])).content[0].text, /ambiguous/);

    assert.match(
      (await run(s, [{ model: "not-a-model", task: "fixture" }])).content[0].text,
      /did not match any available model/,
    );
  });

  test("failure reports the stop reason and error without aborting the parent", async () => {
    const s = setup();
    const result = await run(s, [{ model: "gpt-6-luna", task: "fail" }]);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /failed/);
    assert.match(result.content[0].text, /fixture error/);
  });

  test("cancellation rejects and terminates the child", async () => {
    const s = setup();
    const controller = new AbortController();
    const pending = run(s, [{ model: "gpt-6-luna", task: "hang" }], controller.signal);
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(pending, /aborted/);
  });
}
