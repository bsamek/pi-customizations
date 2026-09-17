# pi-customizations

Personal [pi](https://pi.dev) extensions, packaged so they can be versioned,
backed up, and installed on any machine.

## Contents

| Extension | Description |
|-----------|-------------|
| `extensions/edit-failure-tracker.ts` | Keeps a log of failed or ineffective edits and writes, so repeatedly failing attempts are easy to spot and review. Run `/edit-failures` to see a report, or `/edit-failures clear` to reset it. |
| `extensions/git-safety.ts` | Blocks force-pushes and non-draft `gh pr create` commands that pi runs. This only guards commands the agent issues, so it is not a substitute for a git hook on your own terminal. |
| `extensions/notify.ts` | Sends a desktop notification when pi finishes and starts waiting for you, so you can work in another window. Tested in Ghostty; other terminals may not display it. |
| `extensions/session-recap.ts` | Shows a one-line recap of where you left off when you step away — after a few idle minutes in a session with at least a few turns. `/recap off` and `/recap on` toggle automatic recaps, or start with them disabled via `--no-session-recap`; `/recap` shows one on demand either way. |
| `extensions/session-title.ts` | Keeps your terminal title set to a one-line summary of what the session is about. Regenerate the summary with `/session-title`, or set your own with `/session-title <text>`. |
| `extensions/subagent/` | Adds a `subagent` tool that hands a task to another model — for a second opinion, a review, or several models at once. Subagents get no `edit` or `write` tool and are instructed to stay read-only, but they can still run shell commands. |

`session-title` and `session-recap` write their summaries with a specific
Fireworks model, and quietly disable themselves when that model is unavailable
or unauthenticated.

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

The listed paths are relative to the package root, and they can be globs, for
example `["extensions/*.ts", "!extensions/session-recap.ts"]`. Filtering only
changes which resources load; the package is still fetched and updated the same
way.

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
```

To iterate without pushing, temporarily install your working copy instead.
Remove the git package first — keeping both would register the `subagent` tool
twice and fail to load:

```bash
pi remove git:github.com/bsamek/pi-customizations
pi install ~/src/pi-customizations
# ...iterate... then switch back
```
