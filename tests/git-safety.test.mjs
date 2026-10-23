import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension, createPiMock } = await import("./helpers.mjs");
const { default: extension } = await loadExtension("extensions/git-safety.ts");

async function check(command) {
  const mock = createPiMock();
  extension(mock.pi);
  const handler = mock.events.get("tool_call")[0];
  return handler({ toolName: "bash", input: { command } }, { hasUI: false, ui: { notify: () => {} } });
}

test("blocks non-draft pull request creation", async () => {
  assert.equal((await check("gh pr create --title x")).block, true);
  assert.equal(await check("gh pr create --draft --title x"), undefined);
});

test("blocks force-push variants", async () => {
  for (const command of ["git push --force", "git push -f", "git -C repo push --force-with-lease"]) {
    assert.equal((await check(command)).block, true, command);
  }
  assert.equal(await check("git push origin main"), undefined);
});

test("ignores non-bash tools and non-string commands", async () => {
  const mock = createPiMock();
  extension(mock.pi);
  const handler = mock.events.get("tool_call")[0];
  assert.equal(await handler({ toolName: "edit", input: { command: "git push -f" } }, {}), undefined);
  assert.equal(await handler({ toolName: "bash", input: { command: 42 } }, {}), undefined);
});
