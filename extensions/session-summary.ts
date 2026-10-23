/**
 * Session Summary Extension
 *
 * Keeps the terminal title in sync with an AI-generated one-line summary of the
 * current session, and shows a one-line recap when you return to the terminal.
 * Both come from a single model call per settled run.
 *
 * Behavior:
 * - On session start: base title (`π - name - cwd`), then summarize immediately
 *   if the session already has conversation (e.g. resume).
 * - On `agent_settled`: summarize the session, update the title immediately, and
 *   if automatic recaps are enabled, show the recap after `IDLE_TRIGGER_MS`
 *   with no intervening activity. At least one user turn is required.
 * - The recap clears when the next prompt is submitted.
 * - Non-interactive modes (`-p`, `--json`) never generate summaries.
 * - On `session_info_changed` (pi resets the title when the session name
 *   changes): re-apply the summarized title.
 *
 * Usage:
 *   /recap                  generate and show a recap now
 *   /recap off              disable automatic recaps for this session
 *   /recap on               re-enable them
 *   /session-title          regenerate the title now
 *   /session-title <text>   set the title manually
 *   pi --no-session-recap   start with automatic recaps disabled
 *
 * The summary uses `github-copilot/gpt-6-luna` with cheap one-off request
 * options. Failures are silent and keep the previous title.
 *
 * Limitation: Claude Code also requires the terminal to be unfocused, but pi
 * does not expose terminal focus/blur to extensions (pi-tui consumes the
 * focus-reporting sequences internally), so the trigger here is idle time.
 */

import path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const MODEL_PROVIDER = "github-copilot";
const MODEL_ID = "gpt-6-luna";

/** Idle time after a settled run before an automatic recap is shown. */
const IDLE_TRIGGER_MS = 3 * 60 * 1000;
/** Automatic recaps need at least this many user turns. */
const MIN_USER_TURNS = 1;
const MAX_TITLE_CHARS = 60;
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

type Summary = {
	title?: string;
	recap?: string;
};

type SummaryResult =
	| { ok: true; title?: string; recap?: string; userTurns: number }
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
		"Summarize this coding session for a developer returning to the terminal after being away.",
		"Reply with exactly two labeled lines and nothing else:",
		`Title: at most 6 words, no quotes, no markdown, no trailing period, describing the concrete task or topic (not the conversation itself).`,
		`Recap: one or two plain sentences, at most ${MAX_RECAP_CHARS} characters, saying what is being worked on, what just happened, and what is expected next. If the work looks finished, say so.`,
		"No headings, bullets, or explanation. Use the same language as the conversation.",
		"",
		"<conversation>",
		digest,
		"</conversation>",
	].join("\n");
}

function stripDecorations(text: string): string {
	return text
		.replace(/^[#*\-•\s]+/, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
}

function normalizeTitle(text: string): string | undefined {
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (!firstLine) return undefined;
	const cleaned = stripDecorations(firstLine.replace(/^title\s*:\s*/i, "")).replace(/[.;:,!?]+$/g, "");
	return cleaned ? truncate(cleaned, MAX_TITLE_CHARS) : undefined;
}

function normalizeRecap(text: string): string | undefined {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return undefined;
	const firstLine = lines[0].replace(/^recap\s*:\s*/i, "");
	const cleaned = stripDecorations([firstLine, ...lines.slice(1)].join(" "));
	return cleaned ? truncate(cleaned, MAX_RECAP_CHARS) : undefined;
}

/** Parse the model's `Title:`/`Recap:` response, tolerating unlabeled lines. */
export function parseSummary(text: string): Summary {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return {};

	const titleIndex = lines.findIndex((line) => /^title\s*:/i.test(line));
	const recapIndex = lines.findIndex((line) => /^recap\s*:/i.test(line));

	if (titleIndex >= 0 && recapIndex >= 0) {
		const recapLines = lines.filter((_, index) => index >= recapIndex && index !== titleIndex);
		return {
			title: normalizeTitle(lines[titleIndex]),
			recap: normalizeRecap(recapLines.join("\n")),
		};
	}

	if (titleIndex >= 0) return { title: normalizeTitle(lines[titleIndex]) };
	if (recapIndex >= 0) return { recap: normalizeRecap(lines.slice(recapIndex).join("\n")) };

	const title = normalizeTitle(lines[0]);
	const recap = normalizeRecap(lines.slice(1).join("\n"));
	return recap ? { title, recap } : { title };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-session-recap", {
		description: "Disable automatic session recaps (on-demand /recap still works)",
		type: "boolean",
		default: false,
	});

	/** Set by `/recap on|off`; falls back to the CLI flag. */
	let autoOverride: boolean | undefined;
	let summaryTitle: string | undefined;
	let generation = 0;
	let recapTimer: ReturnType<typeof setTimeout> | null = null;
	/** User turns captured by the most recent summary; gates repeats. */
	let summarizedTurns = -1;
	let inFlight = false;
	let warnedModelProblem = false;

	const isInteractive = (ctx: ExtensionContext) => ctx.mode === "tui" || ctx.mode === "rpc";

	const autoEnabled = (): boolean => {
		if (autoOverride !== undefined) return autoOverride;
		return pi.getFlag("no-session-recap") !== true;
	};

	const baseTitle = (ctx: ExtensionContext): string => {
		const cwd = path.basename(ctx.cwd);
		const name = pi.getSessionName();
		return name ? `π - ${name} - ${cwd}` : `π - ${cwd}`;
	};

	const applyTitle = (ctx: ExtensionContext) => {
		ctx.ui.setTitle(summaryTitle ? `π - ${summaryTitle}` : baseTitle(ctx));
	};

	const cancelRecapTimer = () => {
		if (recapTimer) {
			clearTimeout(recapTimer);
			recapTimer = null;
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

	const scheduleRecap = (ctx: ExtensionContext, recap: string, userTurns: number) => {
		cancelRecapTimer();
		const gen = generation;
		recapTimer = setTimeout(() => {
			recapTimer = null;
			if (gen !== generation || !autoEnabled()) return;
			if (!ctx.isIdle()) return;
			if (countUserTurns(ctx.sessionManager.getBranch()) !== userTurns) return;
			showRecap(ctx, recap);
		}, IDLE_TRIGGER_MS);
	};

	async function generateSummary(
		ctx: ExtensionContext,
		options: { force: boolean },
	): Promise<SummaryResult> {
		if (!isInteractive(ctx)) return { ok: false, reason: "empty" };
		if (inFlight) return { ok: false, reason: "in-flight" };

		const model = ctx.modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
			if (!warnedModelProblem) {
				warnedModelProblem = true;
				if (ctx.hasUI) {
					ctx.ui.notify(
						`session-summary: ${MODEL_PROVIDER}/${MODEL_ID} not found or has no auth; summaries disabled`,
						"warning",
					);
				}
			}
			return { ok: false, reason: "no-model" };
		}

		const userTurns = countUserTurns(ctx.sessionManager.getBranch());
		const digest = buildDigest(ctx.sessionManager.getBranch());
		if (userTurns === 0 || !digest) return { ok: false, reason: "empty" };
		if (!options.force && userTurns <= summarizedTurns) return { ok: false, reason: "stale" };

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
				{ thinkingEnabled: false, cacheRetention: "none", sessionId: uuidv7() },
			);

			// The session changed or the user started another turn while the request
			// was in flight; showing the result now would describe a stale state.
			if (gen !== generation) return { ok: false, reason: "stale" };
			if (countUserTurns(ctx.sessionManager.getBranch()) !== userTurns) {
				return { ok: false, reason: "stale" };
			}

			const text = response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const parsed = parseSummary(text);
			if (!parsed.title && !parsed.recap) return { ok: false, reason: "empty" };

			if (parsed.title) {
				summaryTitle = parsed.title;
				applyTitle(ctx);
			}
			summarizedTurns = Math.max(summarizedTurns, userTurns);
			return { ok: true, ...parsed, userTurns };
		} catch {
			// A missed summary is never worth interrupting the user over.
			return { ok: false, reason: "error" };
		} finally {
			inFlight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		generation++;
		summaryTitle = undefined;
		summarizedTurns = -1;
		warnedModelProblem = false;
		cancelRecapTimer();
		clearRecap(ctx);
		applyTitle(ctx);
		// On resume/reload the branch may already have content; summarize now.
		void generateSummary(ctx, { force: true });
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!isInteractive(ctx)) return;
		const userTurns = countUserTurns(ctx.sessionManager.getBranch());
		if (userTurns < MIN_USER_TURNS) return;
		const gen = generation;
		// Do not make the agent's settled state wait on a summary model call.
		void generateSummary(ctx, { force: false }).then((result) => {
			if (gen !== generation) return;
			if (!result.ok || !result.recap || !autoEnabled()) return;
			scheduleRecap(ctx, result.recap, result.userTurns);
		});
	});

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages are not the user returning to the terminal.
		if (event.source === "extension") return { action: "continue" };
		generation++;
		cancelRecapTimer();
		clearRecap(ctx);
		return { action: "continue" };
	});

	pi.on("session_info_changed", async (_event, ctx) => {
		applyTitle(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		cancelRecapTimer();
		clearRecap(ctx);
		ctx.ui.setTitle(baseTitle(ctx));
	});

	pi.registerCommand("recap", {
		description: "Show a session recap, or enable/disable automatic versions (usage: /recap [on|off])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				autoOverride = arg === "on";
				cancelRecapTimer();
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

			cancelRecapTimer();
			const result = await generateSummary(ctx, { force: true });
			if (result.ok && result.recap) {
				showRecap(ctx, result.recap);
				return;
			}
			if (result.ok && ctx.hasUI) {
				ctx.ui.notify("No recap available for this session yet.", "info");
				return;
			}
			// Silence is kinder than explaining why the recap no longer applies.
			if (!result.ok && result.reason !== "stale" && ctx.hasUI) {
				if (result.reason === "in-flight") {
					ctx.ui.notify("A summary is already being generated.", "info");
				} else {
					ctx.ui.notify(
						"No recap available: the session needs conversation and the summary model must be authenticated.",
						"warning",
					);
				}
			}
		},
	});

	pi.registerCommand("session-title", {
		description: "Set or refresh the session's terminal title (usage: /session-title [title])",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const text = args.trim();
			if (text) {
				summaryTitle = normalizeTitle(text) ?? text;
				applyTitle(ctx);
				ctx.ui.notify(`Terminal title: π - ${summaryTitle}`, "info");
				return;
			}
			const result = await generateSummary(ctx, { force: true });
			if (!result.ok && result.reason !== "stale" && ctx.hasUI) {
				ctx.ui.notify(
					result.reason === "in-flight"
						? "A summary is already being generated."
						: "No conversation to summarize yet",
					"info",
				);
				return;
			}
			ctx.ui.notify(summaryTitle ? `Terminal title: π - ${summaryTitle}` : "No conversation to summarize yet", "info");
		},
	});
}
