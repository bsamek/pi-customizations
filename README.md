# pi-customizations

Personal [pi](https://pi.dev) extensions, packaged so they can be versioned,
backed up, and installed on any machine.

## Contents

| Extension | Description |
|-----------|-------------|
| `extensions/edit-failure-tracker.ts` | Keeps a log of failed edits and writes, plus edits that silently had no effect, so repeatedly failing attempts are easy to spot and review. Run `/edit-failures` to see a report, or `/edit-failures clear` to reset it. |
| `extensions/git-safety.ts` | Blocks force-pushes and non-draft `gh pr create` commands that pi runs. This only guards commands the agent issues, so it is not a substitute for a git hook on your own terminal. |
| `extensions/notify.ts` | Sends a desktop notification when pi finishes and starts waiting for you, so you can work in another window. Tested in Ghostty; Kitty and Windows Terminal are also supported. |
| `extensions/session-recap.ts` | Shows a one-line recap of where you left off when you step away — after a few idle minutes in a session with at least a few turns. `/recap off` and `/recap on` toggle automatic recaps, or start with them disabled via `--no-session-recap`; `/recap` shows one on demand either way. |
| `extensions/session-transcript.ts` | Exports the active session as a compact Markdown transcript for pasting elsewhere: one section per turn, with the prompt and the assistant's prose, and none of the tool calls, results, thinking, or usage that `/export` carries. `/transcript` writes `pi-transcript-<session-id>.md`, `/transcript <path>` writes elsewhere, and `/transcript --editor` opens it in the editor. Only the active branch is exported, and no model call is made. |
| `extensions/session-title.ts` | Keeps your terminal title set to a one-line summary of what the session is about. Regenerate the summary with `/session-title`, or set your own with `/session-title <text>`. |
| `extensions/subagent/` | Adds a `subagent` tool that hands a task to another model — for a second opinion, a review, or several models at once. Subagents get no `edit` or `write` tool and are instructed to stay read-only, but they can still run shell commands, so this is a prompt-level convention rather than a sandbox. |

`session-title` and `session-recap` write their summaries with a specific
Fireworks model. When that model is unavailable or unauthenticated, they warn
once and then stop trying.

## Install

```bash
pi install git:github.com/bsamek/pi-customizations@main
```

`pi install` records the package in `~/.pi/agent/settings.json` and loads its
resources on startup — restart pi if it is already running. To preview without
installing:

```bash
pi -e git:github.com/bsamek/pi-customizations
```

### Installing only some extensions

Nothing obliges you to take the whole set. After installing the package, run
`pi config` and toggle off the extensions you don't want (press Tab to switch
between global and project settings).

To pick extensions declaratively instead, replace the plain package entry in
`~/.pi/agent/settings.json` with the object form and list exactly what to load:

```json
{
  "packages": [
    {
      "source": "git:github.com/bsamek/pi-customizations@main",
      "extensions": ["extensions/notify.ts", "extensions/session-title.ts"]
    }
  ]
}
```

The listed paths are relative to the package root, and they can be globs:

```json
{
  "packages": [
    {
      "source": "git:github.com/bsamek/pi-customizations@main",
      "extensions": [
        "extensions/*.ts",
        "extensions/subagent/index.ts",
        "!extensions/session-recap.ts"
      ]
    }
  ]
}
```

Note that `*` does not recurse, so subdirectories like `extensions/subagent/`
have to be listed by hand. Filtering only changes which resources load; the
package is still fetched and updated the same way.

## Development

Pi installs this repo as a **git package**, so it runs from its own clone at
`~/.pi/agent/git/github.com/bsamek/pi-customizations` — not from your working
copy. Edits to `~/src/pi-customizations` have no effect until they are pushed.

```bash
# edit, then
cd ~/src/pi-customizations
git add -A && git commit -m "..."
git push
pi update --extensions        # pull the new commit into the runtime clone
pi list                       # confirm the package is installed
# restart pi: it loaded the extensions at startup
```

To iterate without pushing, run the working copy directly for a single session:

```bash
pi -e ~/src/pi-customizations
```

To install the working copy as a package instead, remove the git package first —
keeping both loads the same extensions twice and produces a conflict diagnostic:

```bash
pi remove git:github.com/bsamek/pi-customizations
pi install ~/src/pi-customizations
# ...iterate... then switch back
pi remove ~/src/pi-customizations
pi install git:github.com/bsamek/pi-customizations@main
```
