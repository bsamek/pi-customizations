import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const GH_PR_CREATE = /\bgh\s+pr\s+create\b/i;
const DRAFT_FLAG = /(^|[\s])(?:--draft|-d)(?=[\s]|$)/i;
// Allow common git options such as `git -C repo push` before the subcommand.
const GIT_PUSH = /\bgit(?:\s+[^\s;&|]+)*\s+push\b/i;
function hasForcePushFlag(command: string): boolean {
  return /(^|[\s])(?:--force(?:-with-lease)?(?:=[^\s]+)?|-f[a-z]*)(?=[\s]|$)/i.test(command);
}

function blockedReasons(command: string): string[] {
  const reasons: string[] = [];

  if (GH_PR_CREATE.test(command) && !DRAFT_FLAG.test(command)) {
    reasons.push("GitHub pull requests must be opened as drafts; use `gh pr create --draft`.");
  }

  if (GIT_PUSH.test(command) && hasForcePushFlag(command)) {
    reasons.push("Force-pushing is not allowed; use regular `git push` and add commits instead.");
  }

  return reasons;
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
