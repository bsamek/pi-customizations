import { DynamicBorder, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, matchesKey } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const LOG_PATH = join(homedir(), ".pi", "agent", "edit-failures.jsonl");
const TRACKED_TOOLS = new Set(["edit", "write"]);

interface FailureRecord {
  timestamp: string;
  toolName: string;
  path?: string;
  kind: string;
  message?: string;
}

async function readFailures(): Promise<FailureRecord[]> {
  let raw: string;
  try {
    raw = await readFile(LOG_PATH, "utf8");
  } catch {
    return [];
  }

  const records: FailureRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip malformed lines rather than failing the whole report.
    }
  }
  return records;
}

function buildSummary(records: FailureRecord[]): string {
  const byKind = new Map<string, number>();
  const byPath = new Map<string, number>();
  for (const record of records) {
    byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
    const path = record.path ?? "(unknown)";
    byPath.set(path, (byPath.get(path) ?? 0) + 1);
  }

  const lines: string[] = [`Total: ${records.length}`];

  lines.push("", "By kind");
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(count).padStart(4)}  ${kind}`);
  }

  const files = [...byPath].sort((a, b) => b[1] - a[1]);
  lines.push("", "By file");
  for (const [path, count] of files.slice(0, 15)) {
    lines.push(`  ${String(count).padStart(4)}  ${path}`);
  }
  if (files.length > 15) {
    lines.push(`  ...and ${files.length - 15} more file(s)`);
  }

  const recent = [...records].reverse().slice(0, 10);
  lines.push("", "Recent");
  for (const record of recent) {
    const firstLine = (record.message ?? "").split("\n")[0].slice(0, 100);
    lines.push(
      `  ${record.timestamp}  [${record.kind}] ${record.path ?? "?"}` +
        (firstLine ? `\n      ${firstLine}` : ""),
    );
  }

  return lines.join("\n");
}

async function hashFile(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256").update(await readFile(path)).digest("hex");
  } catch {
    return undefined; // File may not exist yet (new file write).
  }
}

export default function (pi: ExtensionAPI) {
  // toolCallId -> hash of the target file before the tool ran.
  const beforeHashes = new Map<string, string | undefined>();

  pi.on("tool_call", async (event, ctx) => {
    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const rawPath = (event.input as { path?: string }).path;
    if (!rawPath) return;
    const absolute = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    beforeHashes.set(event.toolCallId, await hashFile(absolute));
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!TRACKED_TOOLS.has(event.toolName)) return;
    const before = beforeHashes.get(event.toolCallId);
    beforeHashes.delete(event.toolCallId);

    const rawPath = (event.input as { path?: string }).path;
    const absolute = rawPath
      ? isAbsolute(rawPath)
        ? rawPath
        : resolve(ctx.cwd, rawPath)
      : undefined;
    const after = absolute ? await hashFile(absolute) : undefined;

    const reportedError = event.isError === true;
    // Writing identical content is a legitimate no-op, so only flag edits.
    const silentNoOp =
      !reportedError &&
      event.toolName === "edit" &&
      before !== undefined &&
      before === after;

    if (!reportedError && !silentNoOp) return;

    const text = event.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");

    await appendFile(
      LOG_PATH,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        toolName: event.toolName,
        path: absolute,
        kind: reportedError ? "reported-error" : "silent-no-op",
        message: text.slice(0, 1000),
        session: ctx.sessionManager.getSessionFile(),
      }) + "\n",
    );

    const label = reportedError ? "edit failed" : "edit had no effect";
    ctx.ui.notify(`${label}: ${rawPath ?? "?"}`, "warning");
  });

  pi.registerCommand("edit-failures", {
    description: "Show recorded edit/write failures and silent no-ops",
    handler: async (args, ctx) => {
      if (args.trim().toLowerCase() === "clear") {
        const records = await readFailures();
        await writeFile(LOG_PATH, "");
        if (ctx.hasUI) ctx.ui.notify(`Cleared ${records.length} record(s)`, "info");
        return;
      }

      const records = await readFailures();
      if (records.length === 0) {
        if (ctx.hasUI) ctx.ui.notify("No edit failures recorded.", "info");
        return;
      }

      if (ctx.mode !== "tui") {
        if (ctx.hasUI) {
          ctx.ui.notify(`${records.length} edit failure(s) in ${LOG_PATH}`, "warning");
        }
        return;
      }

      const summary = buildSummary(records);
      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));

        container.addChild(border);
        container.addChild(new Text(theme.fg("accent", theme.bold("Edit Failure Report")), 1, 0));
        container.addChild(new Text(summary, 1, 1));
        container.addChild(
          new Text(theme.fg("dim", "Esc/Enter to close  |  /edit-failures clear to reset"), 1, 0),
        );
        container.addChild(border);

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            if (matchesKey(data, "enter") || matchesKey(data, "escape")) done(undefined);
          },
        };
      });
    },
  });
}
