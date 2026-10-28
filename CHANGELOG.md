# Changelog

All notable changes to Visual Impression. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-28

### Fixed

- A conversation's terminal no longer stays unusable after its agent crashes
  or is killed. Claude Code switches on mouse and focus reporting (and more)
  and switches them off only on a clean exit; after any other exit the shell
  that inherits the terminal prints every mouse move as `[<35;10;1M`. The
  resume line a restore types, and the hand-off line from the hub, now end
  with a reset that the shell runs once the agent is gone, for PowerShell,
  cmd and POSIX shells alike.

### Added

- A second URI, `vscode://geniuspudding.visual-impression/focus?session=...`
  (or `pid=...`, or `name=...`, optionally `&cwd=...`), brings a conversation's
  terminal to the front. Another program that knows a conversation finished
  -- the owner's attention strip -- can raise the VS Code window itself, but
  only this extension knows which terminal tab holds the conversation. The
  window that receives the link shows the terminal if it has it; otherwise
  the request is parked for twenty seconds for the window that does, which
  takes it when it is brought forward (and, when the link names a folder,
  that folder's window is brought forward). The link can show a terminal
  that exists and nothing else; a name is honoured only when exactly one
  terminal carries it.

## [0.3.4] - 2026-10-26

### Fixed

- Two bare `codex` terminals in one folder no longer swap conversations
  from scan to scan. Each terminal keeps the conversation it was recorded
  with while the same codex process runs in it; `codex resume <id>` on the
  command line always wins; only a terminal with neither is matched to the
  newest unclaimed rollout in its folder, and the whole window is seated in
  one pass so a claim cannot be stolen by a later terminal.
- The picker shows the last prompt of a long Codex conversation again. On a
  35 MB rollout the last prompt sat 2 MB from the end, past the 512 KB the
  preview read, and Codex's own `<environment_context>` blocks in the
  user's seat were taken for prompts. The tail read grows to 8 MB until a
  prompt the owner typed turns up, and tagged blocks are skipped.
- A Codex record carries the thread's name (from session_index.jsonl) as
  its title, so the picker and the restored terminal are named like a
  Claude one instead of `powershell`.
- Plain shells at the same folder with the same last command are one row,
  which is what a remote server restart under Remote SSH otherwise piles
  up.

## [0.3.3] - 2026-10-25

### Fixed

- A plain terminal no longer comes back twice in the index. Records were
  keyed by pid plus the shell path, which VS Code reports for a terminal it
  was asked to create and not for one it revived after a reload, so every
  reload opened a second record for the same shell. The key is the pid
  alone; a record under the old key is adopted on the next scan, and a key
  that last belonged to a terminal closed over a week ago is moved aside
  rather than reused.
- The restore picker ticks the agent terminals only, the number the
  startup prompt gave; plain shells are listed with their command but left
  unticked, and the prompt says how many there are.
- A shell whose recorded command is a resume -- including the first-byte
  swallowed ones 0.3.0 typed, `laude --resume …` -- is no longer offered;
  any command naming a conversation id is a resume and is never recorded.

## [0.3.2] - 2026-10-24

### Added

- The hand-off URI takes `project=…` as well as `task=…`; it is exported to
  the terminal as `ASSISTANT_HUB_PROJECT`, for a conversation opened on a
  development line rather than a ticket.

## [0.3.1] - 2026-10-24

### Fixed

- A resumed conversation's command, and a hand-off's, is typed only once
  the terminal's shell reports itself ready (or after four seconds for a
  shell without shell integration). Sent at creation, PowerShell swallowed
  the first byte and `claude --resume …` arrived as `laude --resume …`.

## [0.3.0] - 2026-10-24

### Added

- A URI, `vscode://geniuspudding.visual-impression/handoff`, through which
  another program opens a terminal in a folder and starts Claude Code or
  Codex there -- fresh, under a chosen session id, or resuming a known
  conversation -- with a first prompt and a ticket id in the environment.
  A request for a folder this window does not have is parked and the folder
  opened; the window that has it takes the request. The link names an
  agent, ids and a prompt and nothing else; the command is built by the
  extension.

## [0.2.0] - 2026-10-23

### Added

- Read the arrangement of the terminal panes, and rebuild it on restore. VS
  Code does not report which terminals share a tab, so the extension walks
  the panes with `focusNextPane` and watches where focus lands. The walk
  moves focus, and the API cannot say where focus was beforehand, so it runs
  on request: the command **Visual Impression: Remember the terminal
  layout**. `visualImpression.rememberLayout: onBlur` also reads by itself
  after the window has been out of focus for
  `visualImpression.rememberLayoutAfterSeconds`, stops the moment the window
  is in use again, and leaves focus in the terminal that was active. (An
  unreleased build read on every blur and always put focus in a terminal,
  which took keystrokes meant for an editor or a chat panel; that is gone.)
- A restore writes down the arrangement it built, so a project restored once
  keeps its layout across the next reopen without a walk.
- `visualImpression.restoreTerminalsPerTab` decides how restored terminals
  are grouped when there is no reading to go on. A list such as `[2, 1, 3]`
  states a shape per tab.
- `visualImpression.showPreviews` turns off the line of transcript shown in
  the picker, for a screen that is being shared.
- `visualImpression.stateDirectory` moves the index.
- The last command run in a plain terminal is recorded, and typed back into
  the restored terminal without running it.
- A status bar item with the number of conversations that can be brought
  back, so missing the startup notification costs nothing.

### Changed

- The index moved from `~/.wt-tabs/vscode` to `~/.visual-impression`. An
  index in the old place is moved there once, automatically.
- Restored terminals are split into one tab rather than opening a tab each.
- Conversations closed together are offered in the order they were on
  screen, not in the order their shells happened to exit.

### Fixed

- A window reload no longer offers back a conversation that is running in a
  terminal on screen, which would have started a second agent on it.
- One row per conversation in the picker, rather than one per window session.
- Panes restored into a tab come out in the order they were listed.
- The startup prompt no longer waits on a process scan.

## [0.1.0]

First working version: record which agent conversation is in which terminal,
per project, and offer them back when the project is reopened. Claude Code
and Codex, local and over Remote SSH.
