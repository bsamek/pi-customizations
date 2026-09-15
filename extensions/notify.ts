/**
 * Pi Notify Extension
 *
 * Sends a native desktop notification when Pi settles and is waiting for input.
 * The notification carries only the session name, so concurrent sessions are
 * distinguishable at a glance; unnamed sessions fall back to the working
 * directory's basename.
 *
 * Supports multiple terminal protocols:
 * - OSC 777: Ghostty, iTerm2, WezTerm, rxvt-unicode
 * - OSC 99: Kitty
 * - Windows toast: Windows Terminal (WSL)
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * OSC 777 fields are `;`-separated and BEL-terminated, so a semicolon in a
 * session name would inject extra fields and a control byte could truncate the
 * sequence. PowerShell toast payloads are interpolated into single-quoted
 * strings, which single quotes would escape from.
 */
function sanitize(text: string): string {
	return text
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/[;']/g, ",")
		.replace(/\s+/g, " ")
		.trim();
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${body}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${title}').Show(${toast})`,
	].join("; ");
}

function notifyOSC777(title: string, body: string): void {
	process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
	// Kitty OSC 99: i=notification id, d=0 means not done yet, p=body for second part
	process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
	process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyWindows(title: string, body: string): void {
	execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

function notify(title: string, body: string): void {
	const safeTitle = sanitize(title);
	const safeBody = sanitize(body);
	if (process.env.WT_SESSION) {
		notifyWindows(safeTitle, safeBody);
	} else if (process.env.KITTY_WINDOW_ID) {
		notifyOSC99(safeTitle, safeBody);
	} else {
		notifyOSC777(safeTitle, safeBody);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
		// Print and JSON modes emit machine-readable stdout; a raw escape
		// sequence would corrupt that output.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;

		const name = pi.getSessionName()?.trim() || path.basename(ctx.cwd) || "Pi";
		notify(name, "");
	});
}
