/**
 * Session Title Extension
 *
 * Keeps the terminal title in sync with an AI-generated one-line summary of the
 * current session.
 *
 * Behavior:
 * - On session start: base title (`π - name - cwd`), then generate a summary
 *   immediately if the session already has conversation (e.g. resume).
 * - After each settled agent run: generate once for the first turn, then
 *   refresh after every REFRESH_EVERY_USER_TURNS user messages.
 * - On `session_info_changed` (pi resets the title when the session name
 *   changes): re-apply the summarized title.
 *
 * The summary uses `fireworks/accounts/fireworks/models/deepseek-v4p1-flash`
 * with thinking disabled (cheap, fast). Failures are silent and keep the
 * previous title.
 *
 * Usage:
 *   /session-title          regenerate now
 *   /session-title <text>   set the title manually
 *
 * Built from examples/extensions/titlebar-spinner.ts (ctx.ui.setTitle) and
 * examples/extensions/summarize.ts (ctx.modelRegistry.complete).
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "fireworks";
const MODEL_ID = "accounts/fireworks/models/deepseek-v4p1-flash";

/** Refresh the title after this many user messages since the last summary. */
const REFRESH_EVERY_USER_TURNS = 4;
/** Delay after the agent settles before summarizing, to coalesce bursts. */
const SETTLE_DEBOUNCE_MS = 500;
const MAX_TITLE_CHARS = 60;
const MAX_DIGEST_CHARS = 4000;
const MAX_PART_CHARS = 500;

type MessageLike = {
	role?: string;
	content?: unknown;
};

type EntryLike = {
	type?: string;
	message?: MessageLike;
};

function extractText(content: unknown): string {
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
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

function truncate(text: string, limit: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

/** Compact digest: the first user message plus the most recent exchanges. */
function buildDigest(entries: readonly unknown[]): { digest: string; userTurns: number } {
	const userLines: string[] = [];
	const tail: string[] = [];

	for (const raw of entries) {
		const entry = raw as EntryLike;
		if (entry.type !== "message" || !entry.message?.role) continue;
		const { role, content } = entry.message;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractText(content);
		if (!text) continue;
		const line = `${role === "user" ? "User" : "Assistant"}: ${truncate(text, MAX_PART_CHARS)}`;
		if (role === "user") userLines.push(line);
		tail.push(line);
	}

	const recent = tail.slice(-4);
	const firstUser = userLines[0];
	const sections = firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
	return { digest: sections.join("\n\n").slice(0, MAX_DIGEST_CHARS), userTurns: userLines.length };
}

function buildPrompt(digest: string): string {
	return [
		"Write a title for this AI coding session.",
		"One line, at most 6 words. No quotes, no markdown, no trailing period, no explanation.",
		'Describe the concrete task or topic (e.g. "fix OAuth token refresh"), not the conversation itself.',
		"Use the same language as the conversation.",
		"",
		"<conversation>",
		digest,
		"</conversation>",
	].join("\n");
}

function normalizeTitle(text: string): string | undefined {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;
	const cleaned = firstLine
		.replace(/^[#*\-•\s]+/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(/[.;:,!?]+$/g, "")
		.trim();
	return cleaned ? truncate(cleaned, MAX_TITLE_CHARS) : undefined;
}

export default function (pi: ExtensionAPI) {
	let summary: string | undefined;
	let summarizedUserTurns = -1;
	let inFlight = false;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let generation = 0;
	let warnedModelProblem = false;

	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

	const baseTitle = (ctx: ExtensionContext): string => {
		const cwd = path.basename(ctx.cwd);
		const name = pi.getSessionName();
		return name ? `π - ${name} - ${cwd}` : `π - ${cwd}`;
	};

	const applyTitle = (ctx: ExtensionContext) => {
		ctx.ui.setTitle(summary ? `π - ${summary}` : baseTitle(ctx));
	};

	const cancelDebounce = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
	};

	async function generateTitle(ctx: ExtensionContext, force: boolean) {
		if (!isInteractive(ctx) || inFlight) return;

		const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (!warnedModelProblem) {
				warnedModelProblem = true;
				ctx.ui.notify(`session-title: ${MODEL_PROVIDER}/${MODEL_ID} not found or has no auth; title summaries disabled`, "warning");
			}
			return;
		}

		const { digest, userTurns } = buildDigest(ctx.sessionManager.getBranch());
		if (!digest) return;
		if (!force && summarizedUserTurns >= 0 && userTurns < summarizedUserTurns + REFRESH_EVERY_USER_TURNS) {
			return;
		}

		inFlight = true;
		const gen = generation;
		try {
			const response = await ctx.modelRegistry.complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildPrompt(digest) }],
							timestamp: Date.now(),
						},
					],
				},
				{ thinkingEnabled: false, cacheRetention: "none" },
			);

			// Session changed while the request was in flight; drop the result.
			if (gen !== generation) return;

			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const title = normalizeTitle(text);
			if (title) {
				summary = title;
				summarizedUserTurns = userTurns;
				applyTitle(ctx);
			}
		} catch {
			// Keep the previous title; transient model/network errors are expected.
		} finally {
			inFlight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		summary = undefined;
		summarizedUserTurns = -1;
		warnedModelProblem = false;
		cancelDebounce();
		applyTitle(ctx);
		// On resume/reload the branch may already have content; summarize now.
		void generateTitle(ctx, true);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!isInteractive(ctx)) return;
		const gen = generation;
		cancelDebounce();
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			if (gen !== generation || !ctx.isIdle()) return;
			void generateTitle(ctx, false);
		}, SETTLE_DEBOUNCE_MS);
	});

	// Pi resets the terminal title when the session name changes; re-apply ours.
	pi.on("session_info_changed", async (_event, ctx) => {
		applyTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		cancelDebounce();
		ctx.ui.setTitle(baseTitle(ctx));
	});

	pi.registerCommand("session-title", {
		description: "Set or refresh the session's terminal title (usage: /session-title [title])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = args.trim();
			if (text) {
				summary = normalizeTitle(text) ?? text;
				applyTitle(ctx);
				ctx.ui.notify(`Terminal title: π - ${summary}`, "info");
				return;
			}
			await generateTitle(ctx, true);
			ctx.ui.notify(summary ? `Terminal title: π - ${summary}` : "No conversation to summarize yet", "info");
		},
	});
}
