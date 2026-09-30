/**
 * Session Recap Extension
 *
 * Shows a one-line recap of the session when you return to the terminal after
 * stepping away, mirroring Claude Code's session recap.
 *
 * Behavior:
 * - After each settled run with at least `MIN_USER_TURNS` user turns, a timer
 *   arms for `IDLE_TRIGGER_MS`. If it fires with no intervening activity, a
 *   recap is generated in the background and shown above the editor.
 * - The recap clears when the next prompt is submitted, and a new one is only
 *   generated after new user activity, so it never repeats unchanged.
 * - Non-interactive modes (`-p`, `--json`) never generate recaps.
 *
 * Usage:
 *   /recap                  generate a recap now
 *   /recap off              disable automatic recaps for this session
 *   /recap on               re-enable them
 *   pi --no-session-recap   start with automatic recaps disabled
 *
 * The recap uses `github-copilot/gpt-6-luna` with cheap one-off request
 * options, like `session-title.ts`. Failures are silent.
 *
 * Limitation: Claude Code also requires the terminal to be unfocused, but pi
 * does not expose terminal focus/blur to extensions (pi-tui consumes the
 * focus-reporting sequences internally), so the trigger here is idle time.
 */

import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const MODEL_PROVIDER = "github-copilot";
const MODEL_ID = "gpt-6-luna";

/** Idle time after a settled run before a recap is generated. */
const IDLE_TRIGGER_MS = 3 * 60 * 1000;
/** Automatic recaps need at least this many user turns of history. */
const MIN_USER_TURNS = 3;
/** Claude Code caps recaps at 400 characters; keeping that keeps the widget one line. */
const MAX_RECAP_CHARS = 400;
const MAX_DIGEST_CHARS = 4000;
const MAX_PART_CHARS = 500;
const WIDGET_KEY = "session-recap";

type MessageLike = {
	role?: string;
	content?: unknown;
};

type EntryLike = {
	type?: string;
	message?: MessageLike;
};

type RecapResult =
	| { ok: true; recap: string }
	| { ok: false; reason: "empty" | "error" | "in-flight" | "no-model" | "stale" };

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

function countUserTurns(entries: readonly unknown[]): number {
	let count = 0;
	for (const raw of entries) {
		const entry = raw as EntryLike;
		if (entry.type === "message" && entry.message?.role === "user") count++;
	}
	return count;
}

/**
 * Compact digest: the first user message (the original task) plus the most
 * recent exchanges (the current state). Tool output is omitted because a recap
 * summarizes outcomes, and including it would dominate the prompt.
 */
function buildDigest(entries: readonly unknown[]): string {
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

	const recent = tail.slice(-6);
	const firstUser = userLines[0];
	const sections = firstUser && !recent.includes(firstUser) ? [firstUser, ...recent] : recent;
	return sections.join("\n\n").slice(0, MAX_DIGEST_CHARS);
}

function buildPrompt(digest: string): string {
	return [
		"Write a recap of this coding session for a developer returning to the terminal after being away.",
		`One or two plain sentences, at most ${MAX_RECAP_CHARS} characters. No markdown, no headings, no bullets, no quotes.`,
		"Say what is being worked on, what just happened, and what is expected next. If the work looks finished, say so.",
		"Use the same language as the conversation.",
		"",
		"<conversation>",
		digest,
		"</conversation>",
	].join("\n");
}

function normalizeRecap(text: string): string | undefined {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;
	const cleaned = firstLine
		.replace(/^[#*\-•\s]+/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	return cleaned ? truncate(cleaned, MAX_RECAP_CHARS) : undefined;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-session-recap", {
		description: "Disable automatic session recaps (on-demand /recap still works)",
		type: "boolean",
		default: false,
	});

	/** Set by `/recap on|off`; falls back to the CLI flag. */
	let autoOverride: boolean | undefined;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** User turns captured by the most recent recap; gates repeats. */
	let summarizedTurns = -1;
	let inFlight = false;
	let warnedModelProblem = false;

	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

	const autoEnabled = (): boolean => {
		if (autoOverride !== undefined) return autoOverride;
		return pi.getFlag("no-session-recap") !== true;
	};

	const cancelTimer = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	};

	const showRecap = (ctx: ExtensionContext, recap: string) => {
		if (!ctx.hasUI) return;
		if (ctx.mode === "tui") {
			ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => new Text(`${theme.fg("dim", "recap:")} ${recap}`, 0, 0), {
				placement: "aboveEditor",
			});
			return;
		}
		// RPC clients receive string arrays only; component factories are ignored.
		ctx.ui.setWidget(WIDGET_KEY, [`recap: ${recap}`], { placement: "aboveEditor" });
	};

	const clearRecap = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	async function generateRecap(
		ctx: ExtensionContext,
		options: { userTurns: number; automatic: boolean },
	): Promise<RecapResult> {
		if (inFlight) return { ok: false, reason: "in-flight" };

		const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (!warnedModelProblem) {
				warnedModelProblem = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`session-recap: ${MODEL_PROVIDER}/${MODEL_ID} not found or has no auth; recaps disabled`,
						"warning",
					);
				}
			}
			return { ok: false, reason: "no-model" };
		}

		const digest = buildDigest(ctx.sessionManager.getBranch());
		if (!digest) return { ok: false, reason: "empty" };

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
				// One-off prompt: a fresh routing id keeps it out of the session's
				// cache lineage, and there is nothing to reuse later.
				{ cacheRetention: "none", sessionId: uuidv7() },
			);

			// Summarizing is slow enough that the user can leave and come back, resume
			// work, or switch sessions while the request is in flight. Showing the
			// result then would describe a state the user has already moved past.
			if (gen !== generation) return { ok: false, reason: "stale" };
			if (countUserTurns(ctx.sessionManager.getBranch()) !== options.userTurns) {
				return { ok: false, reason: "stale" };
			}
			if (options.automatic && !autoEnabled()) return { ok: false, reason: "stale" };

			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const recap = normalizeRecap(text);
			if (!recap) return { ok: false, reason: "empty" };

			summarizedTurns = Math.max(summarizedTurns, options.userTurns);
			showRecap(ctx, recap);
			return { ok: true, recap };
		} catch {
			// A missed recap is never worth interrupting the user over.
			return { ok: false, reason: "error" };
		} finally {
			inFlight = false;
		}
	}

	function scheduleRecap(ctx: ExtensionContext) {
		if (!isInteractive(ctx) || !autoEnabled()) return;

		const userTurns = countUserTurns(ctx.sessionManager.getBranch());
		if (userTurns < MIN_USER_TURNS || userTurns <= summarizedTurns) return;

		const gen = generation;
		cancelTimer();
		timer = setTimeout(() => {
			timer = null;
			// Bail if the session changed or the user got busy while we waited.
			if (gen !== generation || !ctx.isIdle()) return;
			if (countUserTurns(ctx.sessionManager.getBranch()) !== userTurns) return;
			void generateRecap(ctx, { userTurns, automatic: true });
		}, IDLE_TRIGGER_MS);
	}

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		summarizedTurns = -1;
		warnedModelProblem = false;
		cancelTimer();
		clearRecap(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduleRecap(ctx);
	});

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages are not the user returning to the terminal.
		if (event.source === "extension") return { action: "continue" };
		cancelTimer();
		clearRecap(ctx);
		return { action: "continue" };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		cancelTimer();
		clearRecap(ctx);
	});

	pi.registerCommand("recap", {
		description: "Show a session recap, or enable/disable automatic recaps (usage: /recap [on|off])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				autoOverride = arg === "on";
				cancelTimer();
				if (!autoOverride) clearRecap(ctx);
				if (ctx.hasUI) {
					ctx.ui.notify(`Automatic session recaps ${autoOverride ? "enabled" : "disabled"}`, "info");
				}
				return;
			}
			if (arg) {
				if (ctx.hasUI) ctx.ui.notify("Usage: /recap [on|off]", "warning");
				return;
			}

			cancelTimer();
			const result = await generateRecap(ctx, {
				userTurns: countUserTurns(ctx.sessionManager.getBranch()),
				automatic: false,
			});
			// Silence is kinder than explaining why the recap no longer applies.
			if (!result.ok && result.reason !== "stale" && ctx.hasUI) {
				if (result.reason === "in-flight") {
					ctx.ui.notify("A recap is already being generated.", "info");
				} else {
					ctx.ui.notify(
						"No recap available: the session needs conversation and the summary model must be authenticated.",
						"warning",
					);
				}
			}
		},
	});
}
