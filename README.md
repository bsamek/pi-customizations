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
| `extensions/session-recap.ts` | Shows a one-line recap above the editor after a few idle minutes, so you can pick up where you left off. Adds a `/recap` command and a `--no-session-recap` flag. |
| `extensions/edit-failure-tracker.ts` | Records failed `edit`/`write` tool calls to `~/.pi/agent/edit-failures.jsonl` and surfaces them in the TUI. |
| `extensions/git-safety.ts` | Blocks non-draft `gh pr create` commands and force-pushing commands. |
| `extensions/subagent/` | `subagent` tool: dispatches read-only pi subprocesses pinned to explicit models (single, fanout, parallel). |

## Development

Pi installs this repo as a **git package**, so it runs from its own clone at
`~/.pi/agent/git/github.com/bsamek/pi-customizations` — not from your working
copy. Edits to `~/src/pi-customizations` have no effect until they are pushed.

```bash
# edit, then
cd ~/src/pi-customizations
git commit -am "..." && git push
pi update --extensions        # pull the new commit into the runtime clone
pi list                       # confirm the package is installed
```

To iterate without pushing, temporarily install your working copy instead.
Remove the git package first — keeping both would register the `subagent` tool
twice and fail to load:

```bash
pi remove git:github.com/bsamek/pi-customizations@main
pi install ~/src/pi-customizations
# ...iterate... then switch back
```

## Notes

- Uses `@earendil-works/pi-coding-agent` and friends as peer dependencies; pi
  bundles these, so they are not vendored here.
- No secrets belong in this repo. Credentials live in `~/.pi/agent/auth.json`,
  which is intentionally never committed.
