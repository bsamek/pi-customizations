import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension, createPiMock } = await import("./helpers.mjs");
const { default: extension } = await loadExtension("extensions/op-safety.ts");

async function check(command) {
  const mock = createPiMock();
  extension(mock.pi);
  const handler = mock.events.get("tool_call")[0];
  return handler({ toolName: "bash", input: { command } }, { hasUI: false, ui: { notify: () => {} } });
}

test("blocks direct op invocations", async () => {
  for (const command of [
    "op --version",
    "op item get Example --fields password",
    "/opt/homebrew/bin/op item list",
    "FOO=1 op item get Example",
    "sudo op item get Example",
    "env OP_ACCOUNT=my op item list",
    "echo hi; op item list",
    "echo $(op item list)",
    "bash -c 'op item list'",
    "xargs op",
  ]) {
    assert.equal((await check(command)).block, true, command);
  }
});

test("allows commands that merely contain op inside a word", async () => {
  for (const command of [
    "open README.md",
    "grep operation src/*.ts",
    "rg stop .",
    "echo 'op'",
    "npm test",
  ]) {
    assert.equal(await check(command), undefined, command);
  }
});

test("ignores non-bash tools and non-string commands", async () => {
  const mock = createPiMock();
  extension(mock.pi);
  const handler = mock.events.get("tool_call")[0];
  assert.equal(await handler({ toolName: "edit", input: { command: "op item list" } }, {}), undefined);
  assert.equal(await handler({ toolName: "bash", input: { command: 42 } }, {}), undefined);
});
