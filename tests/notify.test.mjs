import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension, createPiMock } = await import("./helpers.mjs");
const { default: extension } = await loadExtension("extensions/notify.ts");

async function settle({ mode = "tui", name = "My session" } = {}) {
  const mock = createPiMock();
  mock.sessionName.value = name;
  extension(mock.pi);
  const writes = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    await mock.events.get("agent_settled")[0]({}, { mode, cwd: "/tmp/project" });
  } finally {
    process.stdout.write = original;
  }
  return writes.join("");
}

test("emits an OSC 777 notification in TUI mode", async () => {
  const output = await settle();
  assert.equal(output, "\x1b]777;notify;My session;\x07");
});

test("emits OSC 99 when running under Kitty", async () => {
  const previous = process.env.KITTY_WINDOW_ID;
  process.env.KITTY_WINDOW_ID = "1";
  try {
    const output = await settle();
    assert.match(output, /\x1b\]99;i=1:d=0;My session\x1b\\/);
    assert.match(output, /\x1b\]99;i=1:p=body;\x1b\\/);
  } finally {
    if (previous === undefined) delete process.env.KITTY_WINDOW_ID;
    else process.env.KITTY_WINDOW_ID = previous;
  }
});

test("sanitizes separators and control characters", async () => {
  const output = await settle({ name: "a;b\nc" });
  assert.equal(output, "\x1b]777;notify;a,b c;\x07");
});

test("falls back to the cwd basename when the session is unnamed", async () => {
  const output = await settle({ name: "" });
  assert.equal(output, "\x1b]777;notify;project;\x07");
});

test("does not write raw escapes in print or JSON modes", async () => {
  assert.equal(await settle({ mode: "json" }), "");
  assert.equal(await settle({ mode: "print" }), "");
});
