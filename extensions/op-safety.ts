/**
 * 1Password CLI Safety Extension
 *
 * Blocks `op` commands that pi runs. The 1Password CLI can read every item the
 * user has access to, including private keys and credentials, so an accidental
 * `op item get ...` is easy to turn into a secret exposure.
 *
 * This only guards commands the agent issues through the bash tool. It is not a
 * shell wrapper, a sandbox, or a substitute for restricting vault access.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// `op` only counts at the start of a command (or after a shell separator), not
// as a word inside an argument. Leading env assignments and common wrappers are
// skipped so `FOO=1 op ...`, `sudo op ...`, and `/usr/local/bin/op ...` match.
const ENV_ASSIGNMENTS = "(?:[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+)*";
const WRAPPERS = "(?:(?:sudo|command|exec|env|nohup|time|xargs|eval)\\s+)*";
const OP_COMMAND = new RegExp(
	`(?:^|[;&|()'"\`\\n])\\s*${ENV_ASSIGNMENTS}${WRAPPERS}${ENV_ASSIGNMENTS}(?:[^\\s;&|()'"]*\\/)?op(?:\\s|$)`,
	"m",
);

function blockedReasons(command: string): string[] {
	return OP_COMMAND.test(command)
		? [
				"The 1Password CLI (`op`) is blocked because it can expose vault secrets. " +
					"Ask the user to retrieve the item themselves, or use a purpose-built tool.",
			]
		: [];
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string") return undefined;

		const reasons = blockedReasons(command);
		if (reasons.length === 0) return undefined;

		if (ctx.hasUI) {
			ctx.ui.notify(reasons.join(" "), "warning");
		}

		return { block: true, reason: reasons.join(" ") };
	});
}
