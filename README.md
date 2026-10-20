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

## Known limits

- **Windows only**, for now: the process walk shells out to PowerShell.
- **A terminal that never ran an agent** is recorded as a plain shell and is
  not offered by default; VS Code's own terminal persistence covers it.
- **An agent started and exited** keeps its record: the conversation it ran is
  still the thing worth restoring, so the app is never downgraded to `shell`.
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
