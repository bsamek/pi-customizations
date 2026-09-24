/**
 * Session Transcript Extension
 *
 * Exports the current session as a compact Markdown transcript: one section per
 * turn, with the user's prompt and the assistant's prose, and none of the tool
 * calls, tool results, thinking blocks, or usage data that `/export` carries.
 * The result is the kind of thing you can paste into a chat, an issue, or a doc.
 *
 * Usage:
 *   /transcript                 write to pi-transcript-<session-id>.md in the cwd
 *   /transcript <path>          write to a specific path
 *   /transcript --editor        open the transcript in the editor instead of writing
 *
 * Only the active branch is exported, so abandoned `/tree` branches are omitted.
 * The transcript is generated locally with no model call.
 */

import { writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** Extract the concatenated text blocks from a user or assistant message. */
function textFromContent(content: unknown): string {
	if (typeof content === "string") {
		return content.trim();
	}
	if (!Array.isArray(content)) {
		return "";
	}
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: string };
		if (block.type === "text" && typeof block.text === "string") {
			const text = block.text.trim();
			if (text) parts.push(text);
		}
	}
	return parts.join("\n\n").trim();
}

interface Turn {
	prompt: string;
	reply: string[];
}

/**
 * Split the active branch into turns. A turn starts at each user message and
 * collects the assistant text that follows it, so interleaved tool calls and
 * results drop out naturally.
 */
function collectTurns(branch: readonly SessionEntry[]): Turn[] {
	const turns: Turn[] = [];
	let current: Turn | undefined;

	for (const entry of branch) {
		if (entry.type !== "message") continue; // compaction, labels, model changes, custom state
		const message = entry.message;

		if (message.role === "user") {
			const prompt = textFromContent(message.content);
			if (!prompt) continue;
			current = { prompt, reply: [] };
			turns.push(current);
		} else if (message.role === "assistant" && current) {
			const reply = textFromContent(message.content);
			if (reply) current.reply.push(reply);
		}
	}

	return turns;
}

/** Render turns as Markdown: `# Turn N`, the prompt in bold italics, then the reply. */
export function renderTranscript(branch: readonly SessionEntry[]): string {
	const turns = collectTurns(branch);
	const sections: string[] = [];

	turns.forEach((turn, index) => {
		const parts = [`# Turn ${index + 1}`, "", `***${turn.prompt}***`];
		const reply = turn.reply.join("\n\n").trim();
		if (reply) {
			parts.push("", reply);
		}
		sections.push(parts.join("\n"));
	});

	return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("transcript", {
		description: "Export the active session as a compact Markdown transcript (usage: /transcript [path] [--editor])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// Print and JSON modes have no UI surface; keep file export working there.
			const notify = (message: string, type: "info" | "warning" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			};

			const transcript = renderTranscript(ctx.sessionManager.getBranch());
			if (!transcript) {
				notify("No conversation to export.", "warning");
				return;
			}

			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const editor = tokens.includes("--editor");
			const requested = tokens.filter((token) => token !== "--editor");
			if (requested.length > 1) {
				notify("Usage: /transcript [path] [--editor]", "warning");
				return;
			}

			if (editor && ctx.hasUI) {
				await ctx.ui.editor("Session transcript", transcript);
				return;
			}

			const sessionId = ctx.sessionManager.getSessionId() || "session";
			const path = requested[0] ?? `pi-transcript-${sessionId}.md`;
			const absolute = isAbsolute(path) ? path : resolve(ctx.cwd, path);

			try {
				await writeFile(absolute, transcript, "utf8");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(`Failed to write transcript: ${message}`, "error");
				return;
			}

			notify(`Transcript written to ${absolute}`, "info");
		},
	});
}
