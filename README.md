# Visual Impression

[![CI](https://github.com/GeniusPudding/visual-impression/actions/workflows/ci.yml/badge.svg)](https://github.com/GeniusPudding/visual-impression/actions/workflows/ci.yml)

Remembers which AI coding conversation was running in which terminal, per
project, and offers them back when you reopen the folder. Windows, macOS and
Linux, including over Remote SSH and VS Code Tunnels.

VS Code already restores the *shell* in a terminal. What it cannot restore is
the conversation that was running inside it, because only the agent knows that
and only the window knows which terminal was which.

| Agent | Recognised as | Brought back with |
|---|---|---|
| Claude Code | a `claude` process under the terminal's shell | `claude --resume <id>` |
| Codex | a `codex` process | `codex resume <id>` |
| Antigravity CLI (Gemini) | an `agy` process | `agy --conversation <id>` |

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

### Carry on from another computer, over a VS Code Tunnel

The case this extension is best at: a desktop at home runs all the agents,
and you pick the work up from a laptop elsewhere. A
[VS Code Tunnel](https://code.visualstudio.com/docs/remote/tunnels) needs no
SSH server, open port or VPN -- only the same GitHub (or Microsoft) account on
both machines.

On the desktop, once:

```powershell
code tunnel service install     # sign in, name the machine; starts at logon
```

On the laptop, install the **Remote - Tunnels** extension (or open
`https://vscode.dev/tunnel/<machine>` in a browser), then
`Remote-Tunnels: Connect to Tunnel...` and pick the desktop. The first
connection downloads a VS Code server matching the laptop's version onto the
desktop -- a few minutes on a slow line, instant afterwards.

Then, as with Remote SSH, **install this extension on the tunnel side**: in
the connected window open a terminal (it is a desktop shell) and run setup
from the clone there. The Extensions panel lists it under
`TUNNEL: <machine>`.

What makes it work: the tunnel window opens the *same folder on the same
machine*, so the extension there reads the same history file the desktop
windows wrote. The routine is

1. Before leaving, close the project's window on the desktop. Its agent
   terminals are recorded as closed -- only closed ones are offered, so a
   conversation can never end up running in two places at once.
2. On the laptop, connect, open the folder, and accept `Restore…`. Every
   conversation comes back in its own terminal, resumed by id, running on
   the desktop.

Verified with a Windows 11 desktop and a macOS laptop (VS Code 1.143,
November 2026).

## What the picker ticks

Only conversations: Enter alone brings back the agents, which is the point --
nobody remembers which agent windows a project had open. Plain shells are
listed, with their last command, but unticked. So is a conversation whose
transcript this machine no longer has (`conversation not found on this
machine`): resuming it would only open the agent's empty picker. A
conversation without a title is shown as `Claude conversation 0d0936a0` or
by its transcript's title, never as `powershell`.

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
restore them. The conversations are pre-checked, so `Restore…` then Enter brings the
project back -- see [What the picker ticks](#what-the-picker-ticks). `Don't ask again` turns the notification off for good.

A notification is gone in seconds, though, and what it announces is still
worth finding an hour later -- so the count also sits in the status bar,
`$(history) 3`, and clicking it opens the same picker. It hides itself when
there is nothing to bring back. Missing the notification costs nothing.

### Asking VS Code for a terminal from outside

The extension answers two links. Both carry ids and names that must look
like ids and names, and neither can run anything of the caller's choosing.

#### Opening an agent

Another program on the machine can ask for a terminal with an agent in it
through the extension's URI:

```
vscode://geniuspudding.visual-impression/handoff?cwd=C%3A%2Fwork%2Fproj&agent=claude
    [&task=T-…][&project=…][&session=…][&resume=1][&prompt=…][&title=…]
```

| Parameter | |
|---|---|
| `cwd` | the folder; required |
| `agent` | `claude` (default) or `codex` |
| `task` | a ticket id (`T-…`), exported to the terminal as `ASSISTANT_HUB_TASK` |
| `project` | a development-line id, exported as `ASSISTANT_HUB_PROJECT` |
| `session` | a conversation id: with `resume=1` it is resumed (`claude --resume`, `codex resume`); without, Claude Code is started under it (`--session-id`) |
| `prompt` | one line, up to 500 characters, typed as the first prompt |
| `title` | the terminal's name |

If this window has that folder open, the terminal opens here. Otherwise the
request is parked and the folder opened; the window that has it -- a new one,
or the one VS Code brings forward -- opens the terminal, within two minutes.

The link cannot run anything else: it carries an agent name, ids that must
look like ids, and a prompt. The command line is assembled by the extension
from those, so the worst a bad link can do is start Claude Code or Codex with
a prompt you can see. The owner's assistant hub uses this for its 接手 button.

#### Terminals another tool opened

A tool that starts an agent outside VS Code -- the owner's assistant hub
opens conversations in its own terminal window -- can add them to this
project's index itself, so that opening the folder here offers them back.
Such a record carries `"source": "hub"`, a key that is not a pid
(`hub:<conversation id>`) and an `origin` line shown in the picker. The
extension never marks it closed: it is not a terminal of this window. While
the writer leaves it open it counts as a running conversation, and nothing
resumes it a second time; once the writer closes it, `Restore terminals`
lists it and resumes it like any other.

#### Bringing a conversation's terminal to the front

```
vscode://geniuspudding.visual-impression/focus?session=<conversation id>
    [&pid=<shell pid>][&name=<terminal name>][&cwd=<folder>]
```

| Parameter | |
|---|---|
| `session` | the conversation: a Claude Code session id, a Codex thread id or an Antigravity conversation id (a `codex:` or `agy:` prefix is tolerated) |
| `pid` | the terminal's shell pid, as the index keys it |
| `name` | the terminal's name; honoured only when exactly one open terminal carries it |
| `cwd` | the folder the terminal's window has open; lets a link that lands in the wrong window bring the right one forward |

At least one of `session`, `pid` and `name` is needed; they are tried in that
order, and the first that names an open terminal wins. A closed record is
never an answer. If this window has the terminal it is shown and focused.
Otherwise the request is parked for twenty seconds for the window that does,
which takes it when it is brought forward -- and when `cwd` is given, that
folder's window is brought forward by the request itself. A program raising
the window by other means first (the attention strip knows the window by its
title) lands the link in that window directly.

The link can show a terminal that exists and nothing else: no command is
typed, nothing is opened, and a link that names nothing is ignored. The
owner's attention strip (windoalls' attenssion) sends it when a lamp for a
VS Code conversation is clicked, so the click lands on the tab, not just the
window.

## Settings

| Setting | Default | |
|---|---|---|
| `visualImpression.promptOnStartup` | `true` | offer to restore when a project with history is opened |
| `visualImpression.scanIntervalSeconds` | `45` | how often to re-check which agent each terminal is running |
| `visualImpression.historyDays` | `14` | forget terminals closed longer ago than this |
| `visualImpression.showPreviews` | `true` | show a line of each conversation, read from the agent's transcript; off for a shared screen |
| `visualImpression.stateDirectory` | `~/.visual-impression` | where the per-project index is kept |
| `visualImpression.rememberLayout` | `manual` | when to read which terminals share a tab: `manual` (on command only), `onBlur` (also by itself; focus ends in a terminal), `off` |
| `visualImpression.rememberLayoutAfterSeconds` | `20` | in `onBlur` mode, how long the window must have been out of focus before a reading starts |
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

**The Antigravity CLI** (`agy`, Google's Gemini agent) keeps a log per start
under `~/.gemini/antigravity-cli/log/`. Its first line names the process
(`Starting language server process with pid N`) and every message you send is
logged against the conversation it went to, so the terminal's `agy` process
leads to its log and the log to the conversation -- the last one *you* wrote
to, which leaves out the conversations its subagents open. A terminal started
as `agy --conversation <id>`, which is every one this extension restores, says
so on its command line and the log is not consulted. An `agy` that has not been
given a first message has no conversation yet and none is recorded; reopening
that terminal runs `agy -c`, which continues the newest conversation agy has
for the folder (it has no picker flag). The picker shows the last prompt from
`history.jsonl`; a conversation you deleted in agy is listed unticked.

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
back round, and that cycle is one tab. It takes a few hundred milliseconds,
and focus visibly moves while it runs.

That is the catch. The API cannot say where focus was *before* the walk --
in a terminal, in an editor, in a chat panel -- so there is no way to put it
back there. After a walk, focus is in a terminal, whatever it was in before.
A walk that ran by itself while you were in another application would leave
your next keystrokes in a shell. So, by default, **the arrangement is read
only when you ask**:

- **Visual Impression: Remember the terminal layout** walks the panes now and
  reports what it saw (`remembered 3 tabs (2 + 1 + 3 panes)`). Run it before
  closing a project whose arrangement you want back. Focus ends up in the
  terminal that was active.
- A restore writes down the arrangement it builds, since it knows that
  without looking. A project restored once keeps its layout across the next
  reopen with no walk at all, unless you rearranged it by hand.
- **Visual Impression: Show tracked terminals** prints the current reading.
- `visualImpression.rememberLayout`: `manual` (default), `onBlur`, `off`.

`onBlur` is for people who type in the terminal, because that is where focus
lands afterwards. It reads by itself once the window has been out of focus
for `visualImpression.rememberLayoutAfterSeconds` (20) -- a glance at another
window does not count -- and stops at the next step if the window is used
again, discarding the half-reading. It is also skipped when there are fewer
than two terminals, when no terminal is active to hand focus to, and when
the same terminals were read less than fifteen minutes ago.

Which terminals share a tab comes out exact. The order *within* a tab does
not: the walk enters each tab at its earliest-created pane and wraps, so a
tab reads left to right only if its panes were split in the order they were
created. Pane widths cannot be read or set by an extension at all.

## Data and privacy

Nothing leaves the machine. There is no telemetry, no network access of any
kind, and no runtime dependencies.

| What it reads | Why |
|---|---|
| the process table | to tell which terminal is running `claude`, `codex` or `agy`, and with which conversation |
| `~/.codex/sessions/**`, `~/.claude/projects/**`, `~/.claude/sessions/**`, `~/.gemini/antigravity-cli/{log,conversations,history.jsonl}` | the agent's own transcripts and logs, for the conversation id and the line shown in the picker |
| the command you last ran in a plain terminal | so a restored terminal can offer it back |

| What it writes | Where |
|---|---|
| one JSON file per project: terminal names, working directories, pids, conversation ids and times | `~/.visual-impression/`, or `visualImpression.stateDirectory` |

The picker and the status report show a line of the conversation --
its title and last prompt. `visualImpression.showPreviews: false` turns that
off and lists terminals by name alone, which is what you want on a screen
that is being shared. **Visual Impression: Forget this workspace's history**
deletes a project's file; the directory is yours to delete at any time.

A restored agent terminal runs `claude --resume <id>`, `codex resume <id>` or
`agy --conversation <id>`, and nothing else on that line. A crashed or killed agent
leaves the terminal in the modes it switched on (mouse and focus reporting,
win32-input-mode, the kitty keyboard protocol), and the shell then prints
every mouse move as `[<35;10;1M`; so when the shell integration reports the
agent's line ending with an exit that was not clean, the extension types a
reset into the terminal then -- and only then. A terminal without shell
integration, where nobody hears the exit, carries the reset on the agent's
own line instead. The hand-off line from the hub is treated the same way. A
restored plain terminal has its last command typed into it and **not** run
-- reopening a project must never re-run a deploy or a migration.

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
- **Two bare `codex` terminals in one folder** cannot be told apart from
  outside: Codex writes nothing that names the terminal. Each is matched to
  the newest rollout in the folder not yet claimed, in window order, and
  then keeps that seat for as long as the same codex process runs in it --
  so the pair cannot swap from scan to scan, but the very first guess can
  still be the wrong way round. A terminal opened with `codex resume <id>`,
  which is every one this extension restores, is never guessed.
- **An Antigravity conversation has no title in the picker.** agy keeps its
  titles in a SQLite file and the steps as protobuf, and this extension has
  no runtime dependencies to read either; the row is named
  `Antigravity conversation 046c6a10` and shows your last prompt. The agy
  side was verified on Windows (agy 1.4.12); on macOS and Linux it relies on
  the same `~/.gemini/antigravity-cli` layout and has not been run there.
  The hand-off link (`/handoff`) starts Claude Code or Codex only.
- **A conversation is offered once.** Records are keyed by shell pid, so
  every reopen of the window writes the same conversation again under a new
  key. The picker shows the newest of them and hides a conversation that is
  running right now -- two terminals on one conversation helps nobody.
- **A pid is matched together with when its shell started.** A host that
  reboots hands the same small pids out again; the process start (`/proc`
  starttime plus boot time on Linux, `CreationDate` on Windows) keeps a new
  shell from inheriting the conversation an earlier shell with that pid ran.
  macOS `ps` is not asked for it, so there a pid still stands alone.
- **A shell that ran nothing is not offered.** VS Code revives those itself,
  with their directory and their scrollback. One that ran something is
  listed with the command, unticked: the startup prompt counts agent
  terminals, and Enter in the picker brings back exactly those.
- **The scrollback does not come back.** The conversation resumes from the
  agent's own log; whatever was printed on screen is gone.

## Development

```
npm ci
npm run lint
npm test             # 101 unit tests; three of them read the real process table
npm run test:vscode  # 6 tests in a real VS Code, downloaded on first run
npm run check        # all three, which is what CI runs
npm run package      # builds the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.
`docs/toolchain.md` lists every tool and what uses it.

The VS Code the integration tests download registers itself for `vscode://`
links, as every VS Code does on starting; `npm run test:vscode` reads the
handler before the run and puts it back after, and says so when it had to.
Running that VS Code any other way (by hand, or through `vscode-test`
directly) leaves the handler pointing at the test copy, and the next
`vscode://` link starts it as a second VS Code with every window of the first
reopened in it. On Windows the value is
`HKCU\Software\Classes\vscode\shell\open\command`; windoalls'
`attn doctor` reports it and `attn fix-vscode-link` repairs it.

The integration tests matter more than their number suggests: they are what
pins the two pieces of VS Code behaviour the arrangement depends on, both of
which are undocumented, and one of which has a trap in it that makes splits
fail silently. The note at the top of `integration/layout.spec.js` explains
it.

MIT.

The Windows Terminal side of the same problem -- tabs outside VS Code -- is
handled by [windoalls](https://github.com/GeniusPudding/windoalls), which
reads this extension's index so that one command answers "where was I".
