# Visual Impression

Remembers which AI coding conversation was running in which terminal, per
project, and offers them back when you reopen the folder. Windows, macOS and
Linux, including over Remote SSH.

VS Code already restores the *shell* in a terminal. What it cannot restore is
the conversation that was running inside it, because only the agent knows that
and only the window knows which terminal was which.

## Quick start

Not on the Marketplace yet, so install it from source -- one clone and one
command, on any of the three platforms:

```bash
git clone https://github.com/GeniusPudding/visual-impression
cd visual-impression && ./scripts/setup.sh          # macOS, Linux
```

```powershell
git clone https://github.com/GeniusPudding/visual-impression
cd visual-impression; .\scripts\setup.ps1          # Windows
```

Then reload the window. `./scripts/setup.sh --check` (or `-Check`) reports
what is installed and runs the tests, including the ones that read this
machine's real process table -- which is the part worth verifying on a
platform you have not tried before.

### Which machine, over Remote SSH

A Remote SSH session is two halves: the window on your laptop, and a server
on the host. **Install on the host.** Terminals in that window are processes
there, the agents run there, and `~/.codex` is the host's -- your laptop
sees none of it.

So: open the connected window, open a terminal in it (that terminal is
already on the host), and clone and install from there. The `code` on its
PATH is the host's, which is what makes this work.

Install on the laptop as well only if you also open local folders there and
run agents locally. VS Code keeps the two installations separate on purpose,
and the Extensions panel lists them under `LOCAL` and `SSH: host` to match.

`./scripts/setup.sh --check` names the machine it is running on and says
which half it is, if you are ever unsure.

Requires VS Code 1.93 or newer and Node 18 or newer. `--uninstall` removes
it; recorded history in `~/.wt-tabs/vscode/` is left alone.

## Why an extension, and not an outside tool

A tool outside the editor can watch the process tree and find the agents
easily enough. What it cannot do is say which window they belong to: every
terminal in a VS Code window hangs off one shared `ptyHost` process, so from
outside, six projects' terminals are indistinguishable.

From inside, it is unambiguous. The extension is handed each terminal's shell
pid directly, and it already knows the workspace.

## Commands

| Command | What it does |
|---|---|
| `Visual Impression: Restore terminals` | pick from the agent terminals recorded in this project and bring them back, conversation and all |
| `Visual Impression: Show tracked terminals` | a read-only markdown view of what is open and what can be recovered |
| `Visual Impression: Remember the terminal layout` | read which terminals share a tab now, so a restore can rebuild it |
| `Visual Impression: Forget this workspace's history` | delete this project's index |

When you open a project that has recorded terminals, a notification offers to
restore them. Everything is pre-checked, so `Restore…` then Enter brings the
project back. `Don't ask again` turns the notification off for good.

A notification is gone in seconds, though, and what it announces is still
worth finding an hour later -- so the count also sits in the status bar,
`$(history) 3`, and clicking it opens the same picker. It hides itself when
there is nothing to bring back. Missing the notification costs nothing.

## Settings

| Setting | Default | |
|---|---|---|
| `visualImpression.promptOnStartup` | `true` | offer to restore when a project with history is opened |
| `visualImpression.scanIntervalSeconds` | `45` | how often to re-check which agent each terminal is running |
| `visualImpression.historyDays` | `14` | forget terminals closed longer ago than this |
| `visualImpression.showPreviews` | `true` | show a line of each conversation, read from the agent's transcript; off for a shared screen |
| `visualImpression.stateDirectory` | `~/.visual-impression` | where the per-project index is kept |
| `visualImpression.rememberLayout` | `onBlur` | when to read which terminals share a tab: `onBlur`, `manual`, `off` |
| `visualImpression.restoreTerminalsPerTab` | `3` | how many new terminals to place side by side as splits in one tab; `1` = a tab each; a list such as `[2, 1, 3]` gives each tab its own count |
| `visualImpression.reuseRevivedTerminals` | `true` | resume into a terminal VS Code revived rather than opening another |

## Where it stores things

`~/.visual-impression/<project>.json`, one file per project -- a plain file
rather than the extension's `workspaceState`, so that another tool can read
it and one command outside VS Code still answers "where was I". A window
that never reopens does not take its history with it either.
`visualImpression.stateDirectory` moves it. An index left in the old
location, `~/.wt-tabs/vscode`, is moved across once, automatically.

## Identifying a conversation

**Claude Code** publishes a live pid-to-session map at
`~/.claude/sessions/<pid>.json`, which also carries the conversation's title.
Find the `claude` process under the terminal's shell and the answer is exact.

**Codex publishes nothing**, so its rollouts are matched instead: the rollout
must record `source: vscode` and the terminal's own workspace. That first test
is the exact inverse of the one the Windows Terminal side uses, which *drops*
every `source: vscode` rollout -- those belong to a window it cannot see into.
A subagent records an object rather than a string there and is dropped by both.

If more than one terminal matches, each claims a session so two never land on
the same conversation. If nothing matches, **nothing is recorded**: reopening
then drops you into codex's own picker, which is far better than silently
resuming someone else's thread.

A conversation also spans several rollout files -- the first is named after the
session id, and every later `codex resume` opens a new file carrying its own
uuid in the name while `session_meta` still points at the original. So lookups
read `session_meta`, never the file name.

## Plain terminals, and what they are worth over SSH

A terminal that never ran an agent still had something running in it. VS Code
revives a shell with its directory, so locally there is little left to add --
but over SSH the terminals live on the remote host, and when that host's VS
Code server restarts, nothing survives. The directory goes too.

So the last command is recorded, through shell integration
(`onDidStartTerminalShellExecution`), and put back on the prompt when the
terminal returns -- **typed, not run**. Reopening a window must never re-run a
deploy, a migration or an `rm`. Navigation and screen-clearing are not worth
recording and are filtered out, as are the resume commands this extension
sends itself.

Low-confidence command lines are ignored: VS Code marks those when it read the
text off the screen without markers from the shell integration script, which
means it may not be a command at all. A shell with no shell integration
records nothing, which is the honest outcome.

## Reading the arrangement

`window.terminals` is flat, so the only way to find out which terminals share
a tab is to walk it: focus a terminal, press `focusNextPane` until focus comes
back round, and that cycle is one tab. The extension does exactly that, and
then puts focus back where it found it. It takes a few hundred milliseconds
and focus visibly moves while it runs, so it is done when the window loses
focus -- you are in another application, and the reading is fresh for
whenever the window is closed.

- `visualImpression.rememberLayout`: `onBlur` (default), `manual`, `off`.
- **Visual Impression: Remember the terminal layout** runs it on demand and
  reports what it saw (`remembered 3 tabs (2 + 1 + 3 panes)`).
- **Visual Impression: Show tracked terminals** prints the current reading.
- It is skipped when there are fewer than two terminals, when no terminal is
  active to hand focus back to, and when nothing has changed since the last
  reading.

Which terminals share a tab comes out exact. The order *within* a tab does
not: the walk enters each tab at its earliest-created pane and wraps, so a
tab reads left to right only if its panes were split in the order they were
created. Pane widths cannot be read or set by an extension at all.

## Data and privacy

Nothing leaves the machine. There is no telemetry, no network access of any
kind, and no runtime dependencies.

| What it reads | Why |
|---|---|
| the process table | to tell which terminal is running `claude` or `codex`, and with which conversation |
| `~/.codex/sessions/**`, `~/.claude/projects/**`, `~/.claude/sessions/**` | the agent's own transcripts, for the conversation id and the line shown in the picker |
| the command you last ran in a plain terminal | so a restored terminal can offer it back |

| What it writes | Where |
|---|---|
| one JSON file per project: terminal names, working directories, pids, conversation ids and times | `~/.visual-impression/`, or `visualImpression.stateDirectory` |

The picker and the status report show a line of the conversation --
its title and last prompt. `visualImpression.showPreviews: false` turns that
off and lists terminals by name alone, which is what you want on a screen
that is being shared. **Visual Impression: Forget this workspace's history**
deletes a project's file; the directory is yours to delete at any time.

A restored agent terminal runs `claude --resume <id>` or
`codex resume <id>`. A restored plain terminal has its last command typed
into it and **not** run -- reopening a project must never re-run a deploy or
a migration.

## Known limits

- **macOS and Linux are written but not yet verified.** The process walk is
  the only platform-specific part: `ps -ax -ww -o pid=,ppid=,args=` there,
  `Get-CimInstance Win32_Process` on Windows -- measured at a few milliseconds
  against 1.2s, and that 1.2s is PowerShell starting, not the query. Two
  things still need confirming on a real machine: that Claude Code publishes
  `~/.claude/sessions/<pid>.json` there as it does on Windows, and that `ps`
  accepts the repeated `-w`.
- **Over SSH the extension runs on the remote host**, which is where it
  belongs: the terminals, the agents and `~/.codex` are all there. Its index
  is written to the remote home, so that machine answers for its own
  terminals.
- **A terminal that never ran an agent** is recorded as a plain shell and is
  not offered by default; VS Code's own terminal persistence covers it.
- **An agent started and exited** keeps its record: the conversation it ran is
  still the thing worth restoring, so the app is never downgraded to `shell`.
- **The split layout cannot be read.** `window.terminals` is a flat list and
  `Terminal` exposes no group, so an extension cannot see which terminals share
  a tab. VS Code keeps that arrangement itself, in
  `terminal.integrated.layoutInfo`, keyed by a persistent process id the
  extension API never hands out -- so even reading it would not map back to a
  record. Instead of fighting this, a restore resumes into the terminals VS
  Code has already revived, which are by definition sitting in the original
  arrangement. Which pane ends up with which conversation may differ; the
  arrangement survives.

  When there is nothing to revive -- a window reopened after the pty host is
  gone, the normal case for a Remote SSH window -- the arrangement is gone
  with it and the extension has to pick one. It splits the restored terminals
  into groups of `visualImpression.restoreTerminalsPerTab` (3) rather than
  giving each a tab of its own, so the project comes back with several
  terminals on screen instead of one visible and the rest hidden behind tabs.
  Creating a terminal beside a given parent is the one piece of layout the
  API does allow.

  What the extension *can* do is read the arrangement before the window goes,
  and that is what `visualImpression.rememberLayout` does -- see below. When a
  reading exists it decides which conversations share a tab and in what
  order, and `restoreTerminalsPerTab` only covers what the reading does not
  mention. A project can also just state its shape there: `[2, 1, 3]` means
  two panes in the first tab, one in the second, three in the third, with the
  last entry repeating. To rearrange afterwards: **Terminal: Join Terminals...**
  from the command palette merges another terminal into the active tab, and
  multi-selecting tabs in the terminal list offers **Join Terminals** on the
  right-click menu. Relative pane sizes cannot be set by an extension at all.
- **A conversation is offered once.** Records are keyed by shell pid, so
  every reopen of the window writes the same conversation again under a new
  key. The picker shows the newest of them and hides a conversation that is
  running right now -- two terminals on one conversation helps nobody.
- **A shell that ran nothing is not offered.** VS Code revives those itself,
  with their directory and their scrollback. One that ran something is
  offered, with the command.
- **The scrollback does not come back.** The conversation resumes from the
  agent's own log; whatever was printed on screen is gone.

## Development

```
npm ci
npm run lint
npm test             # 54 unit tests; three of them read the real process table
npm run test:vscode  # 4 tests in a real VS Code, downloaded on first run
npm run check        # all three, which is what CI runs
npm run package      # builds the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.
`docs/toolchain.md` lists every tool and what uses it.

The integration tests matter more than their number suggests: they are what
pins the two pieces of VS Code behaviour the arrangement depends on, both of
which are undocumented, and one of which has a trap in it that makes splits
fail silently. The note at the top of `integration/layout.spec.js` explains
it.

MIT.

The Windows Terminal side of the same problem -- tabs outside VS Code -- is
handled by [windoalls](https://github.com/GeniusPudding/windoalls), which
reads this extension's index so that one command answers "where was I".
