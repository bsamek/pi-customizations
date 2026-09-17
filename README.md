# pi-customizations

Personal [pi](https://pi.dev) extensions, packaged so they can be versioned,
backed up, and installed on any machine.

## Contents

| Extension | Description |
|-----------|-------------|
| `extensions/edit-failure-tracker.ts` | Keeps a log of failed edits and writes, so repeatedly failing attempts are easy to spot and review. Run `/edit-failures` to see a report, or `/edit-failures clear` to reset it. |
| `extensions/git-safety.ts` | Blocks force-pushes and non-draft `gh pr create` commands. |
| `extensions/notify.ts` | Sends a desktop notification when pi finishes and starts waiting for you, so you can work in another window. |
| `extensions/session-recap.ts` | Shows a one-line recap of where you left off when you come back to the terminal after stepping away. Add or remove it per session with `/recap on` and `/recap off`, or start with it disabled via `--no-session-recap`. |
| `extensions/session-title.ts` | Keeps your terminal title set to a one-line summary of what the session is about. Refine it any time with `/session-title`, or set it yourself with `/session-title <text>`. |
| `extensions/subagent/` | Adds a `subagent` tool that hands a task to another model — for a second opinion, a review, or several models at once. Subagents are read-only and never edit your files. |

## Install

```bash
pi install git:github.com/bsamek/pi-customizations@main
```

`pi install` records the package in `~/.pi/agent/settings.json` and loads its
resources on startup. To preview without installing:

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
example `["extensions/*.ts", "!extensions/session-recap.ts"]`. A package that
appears only in its object form is fetched and updated the same way as before.

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
