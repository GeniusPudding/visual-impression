# Changelog

All notable changes to Visual Impression. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
