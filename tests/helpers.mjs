import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

function findPiPackage() {
  if (process.env.PI_TEST_PACKAGE) return process.env.PI_TEST_PACKAGE;

  const candidates = [path.join("/opt/homebrew/lib/node_modules", "@earendil-works", "pi-coding-agent", "package.json")];
  const releases = path.join(os.homedir(), ".pi", "agent", "install", "releases");
  try {
    for (const name of fs.readdirSync(releases).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      candidates.push(path.join(releases, name, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
    }
  } catch {
    // No default installation; rely on PI_TEST_PACKAGE or Homebrew.
  }

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("Could not find the installed pi package; set PI_TEST_PACKAGE to its package.json path.");
  }
  return found;
}

const piPackage = findPiPackage();
const requireFromPi = createRequire(piPackage);
const nodeModules = path.resolve(path.dirname(piPackage), "..", "..");

const alias = Object.fromEntries(
  [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ].map((name) => [name, path.join(nodeModules, name, "dist", "index.js")]),
);
alias.typebox = path.join(nodeModules, "typebox", "build", "index.mjs");

/** Load an extension from this repo with the installed pi dependencies. */
export async function loadExtension(relativePath) {
  const { createJiti } = requireFromPi("jiti");
  const jiti = createJiti(import.meta.url, { alias });
  return jiti.import(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)));
}

/** Create the minimal ExtensionAPI surface used by the extensions under test. */
export function createPiMock() {
  const tools = new Map();
  const commands = new Map();
  const events = new Map();
  const flags = new Map();
  const titles = [];
  const widgets = [];
  const notices = [];
  const sessionName = { value: undefined };

  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    registerFlag: (name, flag) => flags.set(name, flag),
    getFlag: (name) => flags.get(name)?.default,
    on: (name, handler) => events.set(name, [...(events.get(name) ?? []), handler]),
    events: { emit: () => {} },
    getSessionName: () => sessionName.value,
    getActiveTools: () => [],
    setActiveTools: () => {},
    ui: {
      notify: (text) => notices.push(text),
      setStatus: () => {},
      setTitle: (title) => titles.push(title),
      setWidget: (_key, widget) => widgets.push(widget),
    },
  };

  return { pi, tools, commands, events, titles, widgets, notices, sessionName };
}

export function makeContext({ branch = [], complete, mode = "tui" } = {}) {
  const model = { provider: "github-copilot", id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true };
  return {
    cwd: process.cwd(),
    mode,
    hasUI: true,
    thinkingLevel: "low",
    scopedModels: [{ model }],
    modelRegistry: {
      find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
      hasConfiguredAuth: () => true,
      getAvailable: () => [model],
      complete: complete ?? (async () => ({ content: [{ type: "text", text: "Title: Fixture title\nRecap: Fixture recap." }] })),
    },
    sessionManager: { getBranch: () => branch, getSessionId: () => "test-session" },
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      setTitle: () => {},
      setWidget: () => {},
      editor: async () => {},
      select: async () => undefined,
    },
  };
}
