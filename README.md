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
| `extensions/subagent/` | Adds read-only model consultations with `subagent`, plus independent opt-in implementation (`/implementer on`) and read-only codebase exploration (`/explorer on`). All use isolated child processes, not a sandbox. |

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

## Optional implementation and exploration delegation

Model choice and delegation are independent; selecting a main model does not change
either role. Both roles initially default to **off**, with model
`github-copilot/gpt-6-luna`. Their on/off settings and selected models are remembered
independently across sessions in `~/.pi/agent/implementer.json` and
`~/.pi/agent/explorer.json` (or your configured Pi agent directory).

New, resumed, switched, and reloaded sessions restore those saved settings.
Changing a setting does not live-update other sessions that are already running;
reload those sessions to pick it up. Older model-only preference files remain off
until explicitly enabled. If a saved model is unavailable in the new session,
that role stays off with a warning rather than silently selecting another model.

```text
/model github-copilot/gpt-6.1-sol
/implementer on
```

The main model uses its judgment to delegate suitable coding tasks through
`implement`, without asking permission for each dispatch; trivial work can be
done directly. Each child gets a focused task, not the parent conversation, and runs in
the same workspace with read/search/bash/edit/write tools. The coordinator checks
the resulting diff and test results. Only one implementer runs at a time; parent
edit/write/shell calls are blocked while it runs. Other custom mutation tools and
external sessions are not locked, so avoid concurrent changes to the workspace.

```text
/implementer status
/implementer off
/model github-copilot/gpt-6-luna
```

This returns to direct implementation. You can select any enabled open-weights
model with `/model` and work directly, or independently enable delegation.
Use `/implementer model` to open a model picker, or `/implementer model <model>`
to select one directly. Changing the implementer preserves the current on/off mode.
Canonical `provider/model-id`, bare IDs, and unambiguous display names are accepted.
Unavailable or ambiguous model selections leave the current mode unchanged.
The older `/implementer <model>` shorthand still selects a model and enables delegation.

### Independent explorer mode

```text
/explorer on
/explorer off
/explorer status
/explorer model
/explorer model <provider/model-id>
```

`/explorer model` opens a picker; an explicit model argument selects directly.
Model selection preserves the on/off mode, just like the implementer. The
`/explorer <model>` shorthand selects and enables exploration. Both roles can be
on, either one can be on, or both can be off; toggling one never toggles the other.

When enabled, the coordinator uses its judgment to call `explore` for focused
codebase questions without asking permission each time. Trivial lookups can stay
in the main session. Explorers get read/search/bash tools and read-only instructions,
not edit/write. Reports include relevant paths, symbols and line references,
a concise explanation backed by evidence, and uncertainties or next files to inspect.

Up to four explorers can run in parallel. Exploration and implementation never
run simultaneously, and parent edit/write/shell calls are blocked while either
role runs. Custom mutation tools and external sessions are not locked. Explorers
are instructed not to run builds, tests, or other artifact-producing commands.
Read-only bash is a prompt-level convention, **not a sandbox**. Explorer children
also disable extensions, skills and templates, and inherit project context files.

The original `subagent` consultation tool stays read-only and still requires an
explicit request; neither delegation mode authorizes unsolicited reviews.
Implementation children are instructed not to delegate, commit, push, publish,
open PRs, perform destructive operations, or act outside the workspace. **These
are prompt-level restrictions, not a security boundary.** Children have bash and
run with `--no-extensions`, so parent extension safety hooks are not inherited.
They also disable skill and template discovery: Superpowers is not required or
bootstrapped. Project context files such as `AGENTS.md` still apply.

To run the regression tests without model calls:

```bash
node --test tests/implementer.test.mjs
```

The tests resolve host dependencies from the standard Homebrew Pi installation.
For another installation, set `PI_TEST_PACKAGE` to its `package.json` path.

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
