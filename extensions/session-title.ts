/**
 * Session Title Extension
 *
 * Keeps the terminal title in sync with an AI-generated one-line summary of the
 * current session.
 *
 * Behavior:
 * - On session start: base title (`π - name - cwd`), then generate a summary
 *   immediately if the session already has conversation (e.g. resume).
 * - On `before_agent_start`: generate concurrently with the agent run, so the
 *   title is usually ready by the time the first response settles. Generates
 *   once for the first turn, then refreshes after every
 *   REFRESH_EVERY_USER_TURNS user messages.
 * - On `session_info_changed` (pi resets the title when the session name
 *   changes): re-apply the summarized title.
 *
 * The summary is also published on the `session-title:summary` event-bus
 * channel so other extensions (e.g. notify) can use it.
 *
 * The summary uses `github-copilot/gpt-6-luna` with thinking disabled.
 * Failures are silent and keep the previous title.
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

const MODEL_PROVIDER = "github-copilot";
const MODEL_ID = "gpt-6-luna";

/** Refresh the title after this many user messages since the last summary. */
const REFRESH_EVERY_USER_TURNS = 4;
/** Event-bus channel carrying the latest summary (or `undefined` on reset). */
const SUMMARY_CHANNEL = "session-title:summary";
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

/**
 * Compact digest: the first user message plus the most recent exchanges.
 *
 * `pendingPrompt` is the just-submitted prompt. It is not in the session
 * branch yet when generated from `before_agent_start`, so fold it in here.
 */
function buildDigest(entries: readonly unknown[], pendingPrompt?: string): { digest: string; userTurns: number } {
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

	if (pendingPrompt) {
		const line = `User: ${truncate(pendingPrompt, MAX_PART_CHARS)}`;
		userLines.push(line);
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

	const publishSummary = (title: string | undefined) => {
		pi.events.emit(SUMMARY_CHANNEL, { summary: title });
	};

	async function generateTitle(ctx: ExtensionContext, force: boolean, pendingPrompt?: string) {
		if (!isInteractive(ctx) || inFlight) return;

		const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (!warnedModelProblem) {
				warnedModelProblem = true;
				ctx.ui.notify(`session-title: ${MODEL_PROVIDER}/${MODEL_ID} not found or has no auth; title summaries disabled`, "warning");
			}
			return;
		}

		const { digest, userTurns } = buildDigest(ctx.sessionManager.getBranch(), pendingPrompt);
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
				publishSummary(title);
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
		applyTitle(ctx);
		publishSummary(undefined);
		// On resume/reload the branch may already have content; summarize now.
		void generateTitle(ctx, true);
	});

	// Start summarizing as soon as the prompt lands, so the model call runs
	// concurrently with the agent and the title is ready when the run settles.
	pi.on("before_agent_start", async (event, ctx) => {
		if (!isInteractive(ctx)) return;
		// Deliberately not awaited: the agent must not wait on the summarizer.
		void generateTitle(ctx, summary === undefined, event.prompt);
	});

	// Pi resets the terminal title when the session name changes; re-apply ours.
	pi.on("session_info_changed", async (_event, ctx) => {
		applyTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		ctx.ui.setTitle(baseTitle(ctx));
	});

	pi.registerCommand("session-title", {
		description: "Set or refresh the session's terminal title (usage: /session-title [title])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = args.trim();
			if (text) {
				summary = normalizeTitle(text) ?? text;
				applyTitle(ctx);
				publishSummary(summary);
				ctx.ui.notify(`Terminal title: π - ${summary}`, "info");
				return;
			}
			await generateTitle(ctx, true);
			ctx.ui.notify(summary ? `Terminal title: π - ${summary}` : "No conversation to summarize yet", "info");
		},
	});
}
