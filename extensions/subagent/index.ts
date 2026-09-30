/**
 * Subagent extension (model-as-parameter variant).
 *
 * Dispatches read-only consultations plus independently enabled implementation
 * and codebase-exploration `pi` subprocesses, pinned to explicit models. The task string is free-form, so the same tool
 * covers review, planning, ideation, and anything else. The point of passing a
 * different model is to decorrelate failure modes: a different model family
 * tends to miss different bugs.
 *
 * Modes (exactly one):
 *   - single:   { model, task }
 *   - fanout:   { models: [...], task }        same task, several models
 *   - parallel: { tasks: [{ model, task }] }   several heterogeneous tasks
 *
 * Consultations and explorers use read-only tool allowlists and prompt guards;
 * implementers also receive edit/write. Project context files (AGENTS.md) are
 * inherited via cwd. Bash restrictions are not a sandbox.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, Usage } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const READ_ONLY_TOOLS = ["read", "grep", "find", "ls", "bash"];
const IMPLEMENTER_TOOLS = [...READ_ONLY_TOOLS, "edit", "write"];
const IMPLEMENTER_GUARD = [
	"You are an implementation subagent. Implement only the supplied task in the current workspace.",
	"Read relevant files and project instructions first. Preserve unrelated and pre-existing changes.",
	"Do not delegate or spawn other agents. Do not commit, push, open PRs, publish, or perform destructive operations.",
	"If the task requires such actions, security-sensitive changes, or side effects outside this workspace, stop and report the blocker.",
	"Run appropriate tests when safe. Report changed files, tests actually run and their results, and unresolved issues.",
	"Do not claim success without checking your work. You have no parent conversation: ask for missing context in your report.",
].join(" ");
const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const COLLAPSED_ITEM_COUNT = 10;

const EXPLORER_GUARD = [
	"You are a read-only subagent exploring a codebase. Do not modify files or git state.",
	"Use bash only for read-only inspection. Do not run builds, tests, formatters, or other commands that write artifacts.",
	"Do not delegate or spawn other agents. Answer only the focused exploration question supplied.",
	"Return relevant file paths, symbols and line references; explain the flow concisely, cite evidence, and identify uncertainties and useful next files.",
	"You do not inherit the parent conversation. Report missing context rather than guessing.",
].join(" ");

const READ_ONLY_GUARD = [
	"You are a read-only subagent. Do not modify the repository.",
	"You may use bash only for read-only commands such as git diff, git log, git show, ls, cat, rg, and find.",
	"Do not run builds, formatters, or tests that write artifacts, and do not change git state or the environment.",
].join(" ");

type Mode = "single" | "fanout" | "parallel";

interface ModelOption {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SubResult {
	requestedModel: string;
	resolvedModel: string;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	mode: Mode;
	results: SubResult[];
}

function emptyUsage(): UsageStats {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function isFailedResult(result: SubResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function getResultOutput(result: SubResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function truncateOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	const omitted = byteLength - Buffer.byteLength(truncated, "utf8");
	return `${truncated}\n\n[Output truncated: ${omitted} bytes omitted. Full output preserved in tool details.]`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function aggregateUsage(results: SubResult[]): UsageStats {
	const total = emptyUsage();
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
		total.contextTokens = Math.max(total.contextTokens, r.usage.contextTokens);
	}
	return total;
}

function toUsage(stats: UsageStats): Usage {
	return {
		input: stats.input,
		output: stats.output,
		cacheRead: stats.cacheRead,
		cacheWrite: stats.cacheWrite,
		totalTokens: stats.input + stats.output + stats.cacheRead + stats.cacheWrite,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: stats.cost,
		},
	};
}

// --- Model discovery and matching -----------------------------------------

function normalize(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function toOption(model: {
	provider: string;
	id: string;
	name?: string;
	reasoning?: boolean;
}): ModelOption {
	return {
		provider: model.provider,
		id: model.id,
		name: model.name ?? model.id,
		reasoning: Boolean(model.reasoning),
	};
}

/**
 * Prefer the user's scoped/enabled models so the parent can only dispatch to
 * models the session actually has credentials and intent for. Falls back to
 * everything with configured auth when no scoping is set.
 */
function availableModels(ctx: {
	scopedModels: readonly { model: { provider: string; id: string; name?: string; reasoning?: boolean } }[];
	modelRegistry: { getAvailable(): { provider: string; id: string; name?: string; reasoning?: boolean }[] };
}): ModelOption[] {
	const scoped = ctx.scopedModels;
	if (scoped.length > 0) {
		return scoped.map((s) => toOption(s.model));
	}
	return ctx.modelRegistry.getAvailable().map(toOption);
}

/**
 * Resolve a user/LLM-supplied model reference against the available models.
 * Accepts a canonical `provider/id`, a bare id, or a display name such as
 * "GLM 5.3 Flash". Returns every option tied at the best score so the caller
 * can surface ambiguity instead of guessing.
 */
function matchModels(query: string, options: ModelOption[]): ModelOption[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const lower = trimmed.toLowerCase();
	const nq = normalize(trimmed);

	const scored = options
		.map((option) => {
			const canonical = `${option.provider}/${option.id}`.toLowerCase();
			const nid = normalize(option.id);
			const nname = normalize(option.name);

			let score = 0;
			if (canonical === lower) score = 100;
			else if (option.id.toLowerCase() === lower) score = 90;
			else if (nname === nq) score = 80;
			else if (nq && nname.includes(nq)) score = 70;
			else if (nq && nq.includes(nname)) score = 65;
			else if (nq && nid.includes(nq)) score = 60;
			else if (nq && normalize(option.provider).includes(nq)) score = 50;
			return { option, score };
		})
		.filter((entry) => entry.score > 0);

	if (scored.length === 0) return [];
	const best = Math.max(...scored.map((entry) => entry.score));
	return scored.filter((entry) => entry.score === best).map((entry) => entry.option);
}

function formatModelList(options: ModelOption[], max = 20): string {
	const shown = options.slice(0, max).map((o) => `${o.name} (${o.provider}/${o.id})`);
	if (options.length > max) shown.push(`... and ${options.length - max} more`);
	return shown.join("\n");
}

// --- Child process plumbing ------------------------------------------------

/**
 * Resolve how to re-invoke pi. Under a real script, exec the current runtime
 * against that script. Under bun's virtual fs or a generic node/bun binary,
 * fall back to `pi` on PATH.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

function writePromptToTempFile(prompt: string): { dir: string; filePath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(dir, "system.md");
	fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	return { dir, filePath };
}

interface RunOptions {
	cwd: string;
	model: ModelOption;
	task: string;
	thinkingLevel?: ThinkingLevel;
	signal?: AbortSignal;
	onUpdate?: () => void;
	implementation?: boolean;
	exploration?: boolean;
}

async function runOne(options: RunOptions, result: SubResult): Promise<SubResult> {
	const { cwd, model, task, thinkingLevel, signal, onUpdate } = options;

	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions"];
	args.push("--model", `${model.provider}/${model.id}`);
	// `--thinking` is only meaningful on reasoning models. Unsupported levels
	// are clamped by the child, but skip it entirely for non-reasoning models.
	if (thinkingLevel && model.reasoning) args.push("--thinking", thinkingLevel);
	args.push("--tools", (options.implementation ? IMPLEMENTER_TOOLS : READ_ONLY_TOOLS).join(","));
	if (options.implementation || options.exploration) args.push("--no-skills", "--no-prompt-templates");

	let promptFile: { dir: string; filePath: string } | null = null;
	try {
		promptFile = writePromptToTempFile(options.implementation ? IMPLEMENTER_GUARD : options.exploration ? EXPLORER_GUARD : READ_ONLY_GUARD);
		args.push("--append-system-prompt", promptFile.filePath);
		args.push(`Task: ${task}`);

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const killProc = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				killTimer = setTimeout(() => proc.kill("SIGKILL"), 5000);
			};
			const cleanup = () => {
				signal?.removeEventListener("abort", killProc);
				if (killTimer) clearTimeout(killTimer);
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);

					if (msg.role === "assistant") {
						result.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							result.usage.input += usage.input || 0;
							result.usage.output += usage.output || 0;
							result.usage.cacheRead += usage.cacheRead || 0;
							result.usage.cacheWrite += usage.cacheWrite || 0;
							result.usage.cost += usage.cost?.total || 0;
							result.usage.contextTokens = usage.totalTokens || 0;
						}
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					onUpdate?.();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					onUpdate?.();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				cleanup();
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 1);
			});

			proc.on("error", (err) => {
				cleanup();
				result.stderr += `\n${err.message}`;
				resolve(1);
			});

			if (signal) {
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return result;
	} finally {
		if (promptFile) {
			try {
				fs.unlinkSync(promptFile.filePath);
			} catch {
				/* ignore */
			}
			try {
				fs.rmdirSync(promptFile.dir);
			} catch {
				/* ignore */
			}
		}
	}
}

// --- Tool parameter schema -------------------------------------------------

const ThinkingLevelSchema = StringEnum(
	["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
	{ description: "Thinking level for the subagent. Defaults to the parent's current level." },
);

const TaskItem = Type.Object({
	model: Type.String({ description: "Model to dispatch, e.g. 'GLM 5.3 Flash' or 'fireworks/.../glm-5p3-flash'." }),
	task: Type.String({ description: "Free-form task instructions for this model." }),
});

const SubagentParams = Type.Object({
	model: Type.Optional(Type.String({ description: "Model for single mode." })),
	task: Type.Optional(Type.String({ description: "Task for single or fanout mode." })),
	models: Type.Optional(
		Type.Array(Type.String(), {
			description: "Models to fan the same task out to, e.g. ['GLM 5.3 Flash', 'GPT-6 Astra'].",
		}),
	),
	tasks: Type.Optional(
		Type.Array(TaskItem, { description: "Heterogeneous parallel tasks, each with its own model and task." }),
	),
	thinking: Type.Optional(ThinkingLevelSchema),
});

export default function (pi: ExtensionAPI) {
	let implementing = false;
	let exploring = 0;

	// One implementation writer or up to MAX_CONCURRENCY read-only explorers.
	// Shell calls are conservatively blocked in the parent during either role.
	pi.on("tool_call", (event) => {
		if ((implementing || exploring > 0) && ["edit", "write", "bash", "powershell"].includes(event.toolName)) {
			return { block: true, reason: "A delegate is running in this workspace. Wait for its result before editing or running shell commands." };
		}
	});

	for (const role of ["implementer", "explorer"] as const) {
		const isImplementation = role === "implementer";
		const toolName = isImplementation ? "implement" : "explore";
		const label = isImplementation ? "Implementation" : "Exploration";
		let selectedModel: ModelOption | undefined;
		let preferredModel = "github-copilot/gpt-6-luna";
		const preferencePath = path.join(getAgentDir(), `${role}.json`);

	const savePreference = (model: string, enabled: boolean) => {
		fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
		const temporary = `${preferencePath}.${process.pid}.tmp`;
		try {
			fs.writeFileSync(temporary, `${JSON.stringify({ model, enabled }, null, 2)}\n`, { mode: 0o600 });
			fs.renameSync(temporary, preferencePath);
		} finally {
			fs.rmSync(temporary, { force: true });
		}
	};

	const disableRole = () => {
		selectedModel = undefined;
		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== toolName));
	};

	pi.on("session_start", (_event, ctx) => {
		disableRole();
		preferredModel = "github-copilot/gpt-6-luna";
		let enabled = false;
		try {
			const saved = JSON.parse(fs.readFileSync(preferencePath, "utf8"));
			if (typeof saved.model !== "string" || !saved.model.trim()) throw new Error("Invalid model preference");
			if (saved.enabled !== undefined && typeof saved.enabled !== "boolean") throw new Error("Invalid enabled preference");
			preferredModel = saved.model;
			enabled = saved.enabled === true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") ctx.ui.notify(`Could not read ${role} preference; using Luna: ${error}`, "warning");
		}
		if (enabled) {
			const matches = matchModels(preferredModel, availableModels(ctx as any));
			if (matches.length === 1) {
				selectedModel = matches[0];
				pi.setActiveTools([...new Set([...pi.getActiveTools(), toolName])]);
			} else {
				ctx.ui.notify(`Saved ${role} model is unavailable: ${preferredModel}. Delegation is off in this session; choose a model with /${role} model.`, "warning");
			}
		}
		ctx.ui.setStatus(role, selectedModel ? `${role}: ${selectedModel.name}` : undefined);
	});

	pi.registerCommand(role, {
		description: `${label} delegation: /${role} on|off|status|model [model]`,
		handler: async (args, ctx) => {
			let query = args.trim();
			if (!query || query === "status") {
				ctx.ui.notify(selectedModel ? `${role}: on (${selectedModel.provider}/${selectedModel.id})` : `${role}: off (direct mode). Selected model: ${preferredModel}`, "info");
				return;
			}
			if (implementing || exploring > 0) {
				ctx.ui.notify("Wait for running delegates to finish before changing mode.", "warning");
				return;
			}
			if (query === "off") {
				try {
					savePreference(preferredModel, false);
				} catch (error) {
					ctx.ui.notify(`Could not save ${role} status; mode unchanged: ${error}`, "warning");
					return;
				}
				disableRole();
				ctx.ui.setStatus(role, undefined);
				ctx.ui.notify(`${label} delegation off. Main model handles this work directly.`, "info");
				return;
			}
			const options = availableModels(ctx as any);
			const selectingModel = query === "model" || query.startsWith("model ");
			if (query === "on") query = preferredModel;
			else if (selectingModel) {
				query = query.slice(5).trim();
				if (!query) {
					if (!ctx.hasUI) {
						ctx.ui.notify(`Use /${role} model <provider/model-id> in non-interactive mode.`, "warning");
						return;
					}
					query = await ctx.ui.select(`Choose ${role} model`, options.map((m) => `${m.provider}/${m.id}`)) ?? "";
					if (!query) return;
				}
			}
			const matches = matchModels(query, options);
			if (matches.length !== 1) {
				ctx.ui.notify(`${matches.length ? "Ambiguous model" : "Unavailable model"}: ${query}\n${formatModelList(matches.length ? matches : options)}`, "warning");
				return;
			}
			const selected = matches[0];
			const canonical = `${selected.provider}/${selected.id}`;
			try {
				savePreference(canonical, selectingModel ? Boolean(selectedModel) : true);
			} catch (error) {
				ctx.ui.notify(`Could not save ${role} model; selection unchanged: ${error}`, "warning");
				return;
			}
			preferredModel = canonical;
			if (selectingModel && !selectedModel) {
				ctx.ui.notify(`Selected ${role}: ${canonical}. Delegation remains off; use /${role} on.`, "info");
				return;
			}
			selectedModel = selected;
			pi.setActiveTools([...new Set([...pi.getActiveTools(), toolName])]);
			ctx.ui.setStatus(role, `${role}: ${selectedModel.name}`);
			ctx.ui.notify(`${isImplementation ? "Implementer" : "Explorer"} on. Model: ${canonical}`, "info");
		},
	});

	pi.registerTool({
		name: toolName,
		label: isImplementation ? "Implement" : "Explore",
		description: isImplementation
			? "Delegate a focused implementation task to the selected implementer. When enabled, use your judgment to delegate suitable coding tasks. Child can edit files and run tests."
			: "Delegate a focused codebase exploration question to the selected explorer. When enabled, use your judgment without asking permission for each dispatch. Child is read-only; returns relevant paths, symbols, line references, flow, and uncertainties.",
		promptSnippet: `Delegate ${isImplementation ? "implementation" : "codebase exploration"} to the selected model`,
		promptGuidelines: [
			isImplementation
				? "Use your judgment to delegate suitable implementation tasks through implement when enabled; verify the resulting diff and tests yourself. You may handle trivial tasks directly."
				: "Use your judgment to delegate focused codebase exploration through explore when enabled; do not ask each time. Read directly for trivial lookups. This is not authorization for unsolicited second opinions or code reviews.",
			"Provide a self-contained task with scope, constraints, relevant paths, and acceptance criteria. Children do not inherit this conversation.",
			"Do not mutate the workspace concurrently with delegates. Explorers may run in parallel, but never alongside an implementer. Only one implementer may run at a time.",
		],
		parameters: Type.Object({ task: Type.String(), thinking: Type.Optional(ThinkingLevelSchema) }),
		async execute(_id, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			if (!selectedModel) throw new Error(`${label} delegation is off. The user must enable /${role} on first.`);
			if (implementing) throw new Error("An implementer is already running. Wait for its result.");
			if (isImplementation && exploring > 0) throw new Error("Explorers are running. Wait for their results before implementing.");
			if (!isImplementation && exploring >= MAX_CONCURRENCY) throw new Error(`At most ${MAX_CONCURRENCY} explorers may run at once.`);
			if (!params.task.trim()) throw new Error(`${label} task must not be empty.`);
			const model = availableModels(ctx as any).find((m) => m.provider === selectedModel!.provider && m.id === selectedModel!.id);
			if (!model) throw new Error(`Selected ${role} is no longer available. Select another with /${role}.`);
			if (isImplementation) implementing = true;
			else exploring++;
			const result: SubResult = {
				requestedModel: model.name, resolvedModel: `${model.provider}/${model.id}`, task: params.task,
				exitCode: -1, messages: [], stderr: "", usage: emptyUsage(),
			};
			const details: SubagentDetails = { mode: "single", results: [result] };
			try {
				await runOne({ cwd: ctx.cwd, model, task: params.task, thinkingLevel: params.thinking ?? ctx.thinkingLevel,
					signal, implementation: isImplementation, exploration: !isImplementation,
					onUpdate: () => onUpdate?.({ content: [{ type: "text", text: `${label} with ${result.resolvedModel}…` }], details }),
				}, result);
				return {
					content: [{ type: "text", text: `${result.resolvedModel} — ${isFailedResult(result) ? "failed" : "completed"}\n\n${truncateOutput(getResultOutput(result))}` }],
					details, usage: toUsage(result.usage), isError: isFailedResult(result),
				};
			} finally {
				if (isImplementation) implementing = false;
				else exploring--;
			}
		},
	});

	pi.on("before_agent_start", (event) => {
		const enabled = selectedModel && event.systemPromptOptions.selectedTools?.includes(toolName);
		return { systemPrompt: `${event.systemPrompt}\n\n## ${label} delegation\n${enabled
			? `The user enabled ${role} delegation to ${selectedModel!.provider}/${selectedModel!.id}. You are the coordinator. Use your judgment to call ${toolName} for suitable ${isImplementation ? "coding tasks" : "codebase exploration questions"}, without asking per dispatch. Supply focused context and verify its findings afterward; trivial work may be done directly. This does not authorize unsolicited review subagents. Do not mutate the workspace concurrently with delegates. Explorers and implementers must not run simultaneously.`
			: `${label} delegation is off. Handle ${isImplementation ? "implementation" : "codebase exploration"} directly; do not launch ${role} agents, even if earlier conversation enabled them. Other delegation roles have independent settings.`}` };
	});
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Dispatch read-only subagents pinned to explicit models, each in an isolated context window.",
			"Only use this when the user asks for it: to consult a specific model, get a second opinion from a different model family, or fan one task out across several models.",
			"Modes (provide exactly one): single {model, task}; fanout {models, task}; parallel {tasks: [{model, task}]}.",
			"Subagents are read-only: they can read, search, and run read-only bash, but cannot modify the repo.",
		].join(" "),
		promptSnippet: "Dispatch a read-only subagent to a specific model for review, planning, or ideation",
		promptGuidelines: [
			"Use subagent only when the user explicitly asks to dispatch a subagent, consult a specific model, or get a second opinion from a different model family. Never invoke it on your own judgment.",
			"If you think a subagent would help but the user has not asked, suggest it and wait for the user to request it.",
			"subagent models must be chosen from the available models listed in the system prompt; it cannot dispatch to models the session has not enabled.",
		],
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentDetails>> {
			const options = availableModels(ctx as any);
			const thinkingLevel = params.thinking ?? ctx.thinkingLevel;

			const hasSingle = Boolean(params.model && params.task);
			const hasFanout = Boolean(params.models && params.models.length > 0 && params.task);
			const hasTasks = Boolean(params.tasks && params.tasks.length > 0);
			const modeCount = Number(hasSingle) + Number(hasFanout) + Number(hasTasks);

			const mode: Mode = hasTasks ? "parallel" : hasFanout ? "fanout" : "single";
			const makeDetails = (results: SubResult[]): SubagentDetails => ({ mode, results });

			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text",
							text: "Invalid parameters. Provide exactly one mode: single {model, task}, fanout {models, task}, or parallel {tasks}.\n\nAvailable models:\n" +
								formatModelList(options),
						},
					],
					details: makeDetails([]),
				};
			}

			// Resolve every requested reference up front so we fail before
			// spending tokens on a partially-valid batch.
			const requested: { reference: string; task: string }[] = hasTasks
				? params.tasks!.map((t) => ({ reference: t.model, task: t.task }))
				: hasFanout
					? params.models!.map((m) => ({ reference: m, task: params.task! }))
					: [{ reference: params.model!, task: params.task! }];

			if (requested.length > MAX_PARALLEL_TASKS) {
				return {
					content: [{ type: "text", text: `Too many subagents (${requested.length}). Max is ${MAX_PARALLEL_TASKS}.` }],
					details: makeDetails([]),
				};
			}

			const resolved: { model: ModelOption; task: string }[] = [];
			const failures: string[] = [];
			for (const item of requested) {
				const matches = matchModels(item.reference, options);
				if (matches.length === 1) {
					resolved.push({ model: matches[0], task: item.task });
				} else if (matches.length > 1) {
					failures.push(
						`"${item.reference}" is ambiguous; matches: ${matches.map((m) => `${m.name} (${m.provider}/${m.id})`).join(", ")}`,
					);
				} else {
					failures.push(`"${item.reference}" did not match any available model.`);
				}
			}

			if (failures.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `${failures.join("\n")}\n\nAvailable models:\n${formatModelList(options)}`,
						},
					],
					details: makeDetails([]),
				};
			}

			const results: SubResult[] = resolved.map((r) => ({
				requestedModel: r.model.name,
				resolvedModel: `${r.model.provider}/${r.model.id}`,
				task: r.task,
				exitCode: -1,
				messages: [],
				stderr: "",
				usage: emptyUsage(),
			}));

			const emitUpdate = () => {
				onUpdate?.({
					content: [{ type: "text", text: `${results.filter((r) => r.exitCode !== -1).length}/${results.length} subagents done` }],
					details: makeDetails([...results]),
				});
			};

			const runAt = async (index: number) => {
				// runOne mutates the placeholder in place, so streaming updates see
				// partial messages and usage before the process exits.
				const run = await runOne(
					{
						cwd: ctx.cwd,
						model: resolved[index].model,
						task: resolved[index].task,
						thinkingLevel,
						signal,
						onUpdate: emitUpdate,
					},
					results[index],
				);
				results[index] = run;
				emitUpdate();
				return run;
			};

			if (resolved.length === 1) {
				const run = await runAt(0);
				if (isFailedResult(run)) {
					return {
						content: [
							{
								type: "text",
								text: `${run.requestedModel} failed (exit ${run.exitCode}${run.stopReason ? `, ${run.stopReason}` : ""}): ${getResultOutput(run)}`,
							},
						],
						details: makeDetails(results),
						usage: toUsage(aggregateUsage(results)),
						// A failed dispatch should not abort the parent turn; the
						// model can decide whether to retry or proceed.
					};
				}
				return {
					content: [{ type: "text", text: getFinalOutput(run.messages) || "(no output)" }],
					details: makeDetails(results),
					usage: toUsage(aggregateUsage(results)),
				};
			}

			await mapWithConcurrencyLimit(resolved, MAX_CONCURRENCY, (_item, index) => runAt(index));

			const summaries = results.map((r) => {
				const status = isFailedResult(r) ? `failed (exit ${r.exitCode}${r.stopReason ? `, ${r.stopReason}` : ""})` : "completed";
				const body = truncateOutput(getResultOutput(r));
				return `### ${r.resolvedModel} — ${status}\n\n${body}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `${results.filter((r) => !isFailedResult(r)).length}/${results.length} subagents succeeded\n\n${summaries.join("\n\n---\n\n")}`,
					},
				],
				details: makeDetails(results),
				usage: toUsage(aggregateUsage(results)),
			};
		},

		renderCall(args, theme, _context) {
			const scope = theme.fg("muted", " [read-only]");
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					scope;
				for (const t of args.tasks.slice(0, 4)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.model)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 4) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 4} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.models && args.models.length > 0) {
				const preview = args.task && args.task.length > 50 ? `${args.task.slice(0, 50)}...` : (args.task ?? "");
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `fanout (${args.models.length} models)`) +
					scope;
				text += `\n  ${theme.fg("muted", args.models.join(", "))}`;
				if (preview) text += `\n  ${theme.fg("dim", preview)}`;
				return new Text(text, 0, 0);
			}
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", args.model ?? "...") +
				scope +
				`\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const usageStr = formatUsageStats(aggregateUsage(details.results));

			if (details.results.length === 1 || details.mode === "single") {
				const r = details.results[0];
				const failed = isFailedResult(r);
				const icon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.resolvedModel))}`;
				if (failed && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;

				if (expanded) {
					const container = new Container();
					container.addChild(new Text(text, 0, 0));
					if (failed && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					const output = getResultOutput(r);
					if (failed && output === "(no output)") container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					else container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
					const stats = formatUsageStats(r.usage, r.resolvedModel);
					if (stats) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", stats), 0, 0));
					}
					return container;
				}

				const output = getResultOutput(r).trim();
				const preview = output.split("\n").slice(0, 3).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const successCount = details.results.filter((r) => !isFailedResult(r)).length;
			const running = details.results.filter((r) => r.exitCode === -1).length;
			const icon = running > 0
				? theme.fg("warning", "⏳")
				: successCount === details.results.length
					? theme.fg("success", "✓")
					: theme.fg("warning", "◐");
			const status = running > 0
				? `${details.results.length - running}/${details.results.length} done, ${running} running`
				: `${successCount}/${details.results.length} succeeded`;

			let text = `${icon} ${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", status)}`;

			if (expanded) {
				const container = new Container();
				container.addChild(new Text(text, 0, 0));
				for (const r of details.results) {
					const failed = isFailedResult(r);
					const rIcon = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
					container.addChild(new Spacer(1));
					container.addChild(new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.resolvedModel)} ${rIcon}`, 0, 0));
					container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(getResultOutput(r).trim(), 0, 0, mdTheme));
					const stats = formatUsageStats(r.usage, r.resolvedModel);
					if (stats) container.addChild(new Text(theme.fg("dim", stats), 0, 0));
				}
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			for (const r of details.results) {
				const failed = isFailedResult(r);
				const rIcon = r.exitCode === -1 ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const preview = getResultOutput(r).trim().split("\n").slice(0, 3).join("\n");
				text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.resolvedModel)} ${rIcon}`;
				text += `\n${theme.fg("toolOutput", preview || "(running...)")}`;
			}
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});

	// Tell the parent which models the session can actually dispatch to. Without
	// this the parent LLM tends to invent plausible-but-unavailable model names.
	pi.on("before_agent_start", async (event, ctx) => {
		// Only advertise models while the subagent tool is active. Disabling the
		// tool (e.g. --exclude-tools subagent) removes this section entirely.
		if (!event.systemPromptOptions.selectedTools?.includes("subagent")) return;

		const options = availableModels(ctx as any);
		if (options.length === 0) return;

		const seen = new Set<string>();
		const lines: string[] = [];
		for (const o of options) {
			const key = `${o.provider}/${o.id}`;
			if (seen.has(key)) continue;
			seen.add(key);
			lines.push(`- ${o.name} (\`${key}\`)`);
		}

		return {
			systemPrompt: `${event.systemPrompt}

## Subagent Models

The \`subagent\` tool dispatches read-only subagents pinned to a specific model. Use it only when the user asks for a cross-model review or second opinion; otherwise suggest one and wait for the user to request it. Available models:
${lines.join("\n")}
`,
		};
	});
}
