# windoalls for VS Code

Remembers which AI coding conversation was running in which terminal, per
project, and offers them back when you reopen the folder.

VS Code already restores the *shell* in a terminal. What it cannot restore is
the conversation that was running inside it, because only the agent knows that
and only the window knows which terminal was which.

## Why an extension, and not the terminal tool

The rest of windoalls tracks Windows Terminal tabs from outside, by walking the
process tree. That cannot work here: every terminal in a VS Code window hangs
off one shared `ptyHost` process, so nothing outside the window can tell which
window -- and therefore which project -- a terminal belongs to.

From inside, it is unambiguous. The extension is handed each terminal's shell
pid directly, and it already knows the workspace.

## Commands

| Command | What it does |
|---|---|
| `windoalls: Restore terminals` | pick from the agent terminals recorded in this project and bring them back, conversation and all |
| `windoalls: Show tracked terminals` | a read-only markdown view of what is open and what can be recovered |
| `windoalls: Forget this workspace's history` | delete this project's index |

When you open a project that has recorded terminals, a notification offers to
restore them. Everything is pre-checked, so `Restore…` then Enter brings the
project back. `Don't ask again` turns the notification off for good.

## Settings

| Setting | Default | |
|---|---|---|
| `windoalls.promptOnStartup` | `true` | offer to restore when a project with history is opened |
| `windoalls.scanIntervalSeconds` | `45` | how often to re-check which agent each terminal is running |
| `windoalls.historyDays` | `14` | forget terminals closed longer ago than this |
| `windoalls.reuseRevivedTerminals` | `true` | resume into a terminal VS Code revived rather than opening another |

## Where it stores things

`~/.wt-tabs/vscode/<project>.json`, one file per project -- deliberately
alongside the terminal tool's own state rather than in `workspaceState`, so
that `wts` can read it and one command still answers "where was I". A window
that never reopens does not take its history with it either.

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
- **The scrollback does not come back.** The conversation resumes from the
  agent's own log; whatever was printed on screen is gone.

## Development

```
npm install
npm run compile
npm test            # 20 tests, node:test, no VS Code needed
npm run package     # builds the .vsix
```

Press `F5` in VS Code to launch an Extension Development Host.

MIT, same as the rest of the repository.
