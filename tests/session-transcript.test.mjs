import assert from "node:assert/strict";
import { test } from "node:test";

const { loadExtension } = await import("./helpers.mjs");
const { renderTranscript } = await loadExtension("extensions/session-transcript.ts");

function message(role, content) {
  return { type: "message", message: { role, content } };
}

test("renders one section per user turn with assistant prose only", () => {
  const branch = [
    message("user", "First prompt"),
    message("assistant", [
      { type: "thinking", thinking: "hidden reasoning" },
      { type: "text", text: "First reply." },
      { type: "toolCall", name: "read", arguments: { path: "x" } },
    ]),
    message("toolResult", [{ type: "text", text: "tool output" }]),
    message("user", [{ type: "text", text: "Second prompt" }]),
    message("assistant", "Second reply."),
  ];

  const transcript = renderTranscript(branch);
  assert.match(transcript, /# Turn 1/);
  assert.match(transcript, /\*\*\*First prompt\*\*\*/);
  assert.match(transcript, /First reply\./);
  assert.match(transcript, /# Turn 2/);
  assert.match(transcript, /\*\*\*Second prompt\*\*\*/);
  assert.match(transcript, /Second reply\./);
  assert.doesNotMatch(transcript, /hidden reasoning/);
  assert.doesNotMatch(transcript, /tool output/);
});

test("skips non-message entries, empty prompts, and replies before a prompt", () => {
  const branch = [
    { type: "model_change", model: "x" },
    message("assistant", "orphan reply"),
    message("user", "   "),
    message("user", "Real prompt"),
    message("assistant", [{ type: "text", text: "   " }]),
  ];

  const transcript = renderTranscript(branch);
  assert.match(transcript, /# Turn 1/);
  assert.match(transcript, /\*\*\*Real prompt\*\*\*/);
  assert.doesNotMatch(transcript, /orphan reply/);
});

test("returns an empty string when there is nothing to export", () => {
  assert.equal(renderTranscript([]), "");
  assert.equal(renderTranscript([message("assistant", "only a reply")]), "");
});
