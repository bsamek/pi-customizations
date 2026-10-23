# pi-customizations

Personal [pi](https://pi.dev) extensions, packaged so they can be versioned,
backed up, and installed on any machine.

## Contents

| Extension | Description |
|-----------|-------------|
| `extensions/git-safety.ts` | Blocks force-pushes and non-draft `gh pr create` commands that pi runs. This only guards commands the agent issues, so it is not a substitute for a git hook on your own terminal. |
| `extensions/notify.ts` | Sends a desktop notification when pi finishes and starts waiting for you, so you can work in another window. Tested in Ghostty; Kitty is also supported. |
| `extensions/session-summary.ts` | Keeps your terminal title set to a one-line AI summary and shows a one-line recap when you return. Both come from one model call per completed turn; the recap appears after 3 idle minutes and requires at least one turn. `/recap` shows one on demand; `/recap off`/`on` toggle automatic recaps, or start with them disabled via `--no-session-recap`. `/session-title` regenerates the title, and `/session-title <text>` sets it manually. |
| `extensions/session-transcript.ts` | Exports the active session as a compact Markdown transcript for pasting elsewhere: one section per turn, with the prompt and the assistant's prose, and none of the tool calls, results, thinking, or usage that `/export` carries. `/transcript` writes `pi-transcript-<session-id>.md`, `/transcript <path>` writes elsewhere, and `/transcript --editor` opens it in the editor. Only the active branch is exported, and no model call is made. |
| `extensions/subagent/` | Adds read-only model consultations with `subagent`. Each call supplies `tasks: [{ model, task }]`; one task is a single consultation, several run concurrently, and repeating a task across models fans it out. Uses isolated child processes, not a sandbox. |

`session-summary` writes its summaries with `github-copilot/gpt-6-luna`. When
that model is unavailable or unauthenticated, it warns once and then stops
trying.

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
      "extensions": ["extensions/notify.ts", "extensions/session-summary.ts"]
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
        "!extensions/session-summary.ts"
      ]
    }
  ]
}
```

Note that `*` does not recurse, so subdirectories like `extensions/subagent/`
have to be listed by hand. Filtering only changes which resources load; the
package is still fetched and updated the same way.

## Tests

Run the regression tests without model calls:

```bash
npm ci
npm test
```

GitHub Actions runs the same suite on Node 22 and 24 for pushes to `main` and
pull requests. Subagent tests spawn the test file as a fake child CLI and assert
its loadout without spending model tokens. The suite uses the Pi package from
`devDependencies`; set `PI_TEST_PACKAGE` to another package's `package.json`
path to test against a different local install.

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
