# pi-customizations

Personal [pi](https://pi.dev) extensions, packaged so they can be versioned,
backed up, and installed on any machine.

## Install

```bash
pi install git:github.com/bsamek/pi-customizations@main
```

`pi install` records the package in `~/.pi/agent/settings.json` and loads its
resources on startup. To preview without installing:

```bash
pi -e git:github.com/bsamek/pi-customizations
```

## Contents

| Extension | Description |
|-----------|-------------|
| `extensions/notify.ts` | Desktop notification when pi settles and waits for input. Supports OSC 777, Kitty OSC 99, and Windows toast. |
| `extensions/session-title.ts` | Keeps the terminal title synced to an AI-generated one-line session summary. Adds a `/session-title` command. |
| `extensions/edit-failure-tracker.ts` | Records failed `edit`/`write` tool calls to `~/.pi/agent/edit-failures.jsonl` and surfaces them in the TUI. |
| `extensions/subagent/` | `subagent` tool: dispatches read-only pi subprocesses pinned to explicit models (single, fanout, parallel). |

## Development

Work on the extensions in this repo, not in `~/.pi/agent/extensions`. Pi loads
them from here via the package entry in settings, so this directory is the
single source of truth.

```bash
pi list          # confirm the package is installed
pi update --extensions   # reinstall after changing source
```

For an iterating loop, install the local checkout instead:

```bash
pi install ~/src/pi-customizations
```

## Notes

- Uses `@earendil-works/pi-coding-agent` and friends as peer dependencies; pi
  bundles these, so they are not vendored here.
- No secrets belong in this repo. Credentials live in `~/.pi/agent/auth.json`,
  which is intentionally never committed.
