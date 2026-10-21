// Visual Impression.
//
// VS Code already restores the shell in a terminal. What it cannot restore is
// the conversation that was running in it, because only the agent knows that
// and only this window knows which terminal was which. So: record the pairing
// while the window is open, and offer it back when the project is reopened.

import * as vscode from 'vscode';
import {
  App,
  TerminalRecord,
  WorkspaceIndex,
  indexPath,
  pruneHistory,
  deleteIndex,
  isWorthRecording,
  readIndex,
  restorable,
  planByLayout,
  TabSizes,
  writeIndex,
} from './store';
import { PaneProbe, probeGroups, sameTerminals } from './layout';
import { invalidateProcessCache } from './procs';
import { invalidateRolloutCache, resolveTerminal } from './resolve';
import { getPreview, oneLine } from './preview';

/** Terminals this window created, so a scan can tell them from a stale record. */
const liveKeys = new WeakMap<vscode.Terminal, string>();
let timer: NodeJS.Timeout | undefined;
let scanning = false;
/** Commands seen before the terminal had a record; the next scan attaches them. */
const pendingCommand = new Map<string, { cmd: string; at: string }>();
let status: vscode.StatusBarItem | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const folder = workspaceFolder();
  if (!folder) {
    return; // no folder open: nothing to key an index to
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('visualImpression.restoreTerminals', () => restoreTerminals(folder)),
    vscode.commands.registerCommand('visualImpression.showStatus', () => showStatus(folder)),
    vscode.commands.registerCommand('visualImpression.forgetWorkspace', () => forgetWorkspace(folder)),
    vscode.commands.registerCommand('visualImpression.rememberLayoutNow', () => rememberLayout(folder, false)),
    // Reading the arrangement moves focus from pane to pane, so it is done
    // when the window is not being typed into.
    vscode.window.onDidChangeWindowState((st) => {
      if (!st.focused) {
        void rememberLayout(folder, true);
      }
    }),
    vscode.window.onDidOpenTerminal(() => scheduleScan(folder, 2500)),
    vscode.window.onDidCloseTerminal((t) => onClosed(folder, t)),
    vscode.window.onDidChangeActiveTerminal(() => scheduleScan(folder, 1500)),
    vscode.window.onDidStartTerminalShellExecution((e) => void onShellExecution(folder, e)),
    { dispose: () => timer && clearTimeout(timer) },
  );

  // A notification is gone in a few seconds, and what it announces is worth
  // finding an hour later. This says the same thing and stays put.
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'visualImpression.restoreTerminals';
  context.subscriptions.push(status);

  // Mark anything still open from the previous run as closed: the window is
  // starting, so by definition none of it survived.
  closeAllStale(folder);

  startPolling(folder, context);

  // The prompt must not wait for a scan. Resolving which agent is in which
  // terminal costs a PowerShell start-up -- over a second -- and the prompt
  // does not need the answer: it only needs to know which terminals are on
  // screen, which VS Code can say in milliseconds. A window reload reconnects
  // its terminals under their original pids, and closeAllStale has just marked
  // those records closed, so without that check a live conversation would be
  // offered back into a second terminal.
  void (async () => {
    await new Promise((r) => setTimeout(r, 800)); // let reconnected ptys report a pid
    await offerRestoreOnStartup(folder);
  })();
  scheduleScan(folder, 1500);
}

export function deactivate(): void {
  const folder = workspaceFolder();
  if (!folder) {
    return;
  }
  // Best effort: VS Code gives deactivate a short, unenforced window, so this
  // does one synchronous pass and no process lookups.
  const ix = readIndex(folder);
  const now = new Date().toISOString();
  for (const t of ix.terminals) {
    if (!t.closedAt) {
      t.closedAt = now;
    }
  }
  writeIndex(ix);
}

function workspaceFolder(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('visualImpression').get<T>(key) ?? fallback;
}

// ------------------------------------------------------------- recording ----

function startPolling(folder: string, context: vscode.ExtensionContext): void {
  const seconds = Math.max(10, cfg('scanIntervalSeconds', 45));
  const handle = setInterval(() => void scan(folder), seconds * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(handle) });
}

/**
 * An agent is usually typed into a terminal a second or two after it opens, so
 * events schedule a delayed scan rather than scanning immediately.
 */
function scheduleScan(folder: string, delayMs: number): void {
  if (timer) {
    clearTimeout(timer);
  }
  timer = setTimeout(() => void scan(folder), delayMs);
}

async function scan(folder: string): Promise<void> {
  if (scanning) {
    return;
  }
  scanning = true;
  try {
    invalidateProcessCache();
    invalidateRolloutCache();

    const ix = readIndex(folder);
    const now = new Date().toISOString();
    const claimed = new Set<string>();
    const seen = new Set<string>();

    for (const term of vscode.window.terminals) {
      const pid = await pidOf(term);
      if (pid === null) {
        continue;
      }
      const key = keyFor(term, pid);
      liveKeys.set(term, key);
      seen.add(key);

      const cwd = cwdOf(term) ?? folder;
      const r = await resolveTerminal(pid, cwd, claimed);
      if (r.session) {
        claimed.add(r.session);
      }

      let rec = ix.terminals.find((t) => t.key === key);
      if (!rec) {
        rec = {
          key,
          name: term.name,
          cwd,
          shellPid: pid,
          app: r.app,
          session: r.session,
          title: r.title,
          openedAt: now,
          lastSeen: now,
          closedAt: null,
          lastCommand: null,
          lastCommandAt: null,
        };
        ix.terminals.push(rec);
      }
      rec.name = term.name;
      rec.cwd = cwd;
      rec.shellPid = pid;
      rec.lastSeen = now;
      rec.closedAt = null;
      // Never downgrade: an agent that has exited leaves a terminal reading as
      // a plain shell, but the conversation it ran is still what this terminal
      // is worth restoring.
      if (r.app !== 'shell') {
        rec.app = r.app;
      }
      if (r.session) {
        rec.session = r.session;
      }
      if (r.title) {
        rec.title = r.title;
      }
      const pend = pendingCommand.get(key);
      if (pend) {
        rec.lastCommand = pend.cmd;
        rec.lastCommandAt = pend.at;
        pendingCommand.delete(key);
      }
    }

    // Anything in the index that is not on screen has gone.
    for (const t of ix.terminals) {
      if (!t.closedAt && !seen.has(t.key)) {
        t.closedAt = now;
      }
    }

    pruneHistory(ix, cfg('historyDays', 14));
    writeIndex(ix);
    showCount(ix, seen);
  } catch {
    /* recording is best effort; never surface an error for it */
  } finally {
    scanning = false;
  }
}

/**
 * What a plain terminal was last doing. VS Code revives a shell with its
 * directory but not with the thing that was running in it, and over SSH not
 * even the directory survives a server restart -- the command is then the
 * only part of the terminal left worth bringing back.
 */
async function onShellExecution(
  folder: string,
  e: vscode.TerminalShellExecutionStartEvent,
): Promise<void> {
  const line = e.execution.commandLine;
  // Low confidence means VS Code read it off the screen without markers from
  // the shell integration script, so it may not be a command at all.
  if (line.confidence === vscode.TerminalShellExecutionCommandLineConfidence.Low) {
    return;
  }
  if (!isWorthRecording(line.value)) {
    return;
  }
  const pid = await pidOf(e.terminal);
  if (pid === null) {
    return;
  }
  const key = liveKeys.get(e.terminal) ?? keyFor(e.terminal, pid);
  const entry = { cmd: line.value.trim(), at: new Date().toISOString() };
  const ix = readIndex(folder);
  const rec = ix.terminals.find((t) => t.key === key);
  if (!rec) {
    pendingCommand.set(key, entry); // the scan has not reached this terminal yet
    return;
  }
  rec.lastCommand = entry.cmd;
  rec.lastCommandAt = entry.at;
  writeIndex(ix);
}

/**
 * The count of conversations this project could bring back, in the status
 * bar. Hidden when there are none, so it is never decoration.
 */
function showCount(ix: WorkspaceIndex, openKeys: ReadonlySet<string>): void {
  if (!status) {
    return;
  }
  const n = restorable(ix, openKeys).filter((t) => t.app !== 'shell').length;
  if (!n) {
    status.hide();
    return;
  }
  status.text = `$(history) ${n}`;
  status.tooltip = `Visual Impression: ${n} conversation${n === 1 ? '' : 's'} can be brought back. Click to pick.`;
  status.show();
}

function onClosed(folder: string, term: vscode.Terminal): void {
  const key = liveKeys.get(term);
  if (!key) {
    return;
  }
  const ix = readIndex(folder);
  const rec = ix.terminals.find((t) => t.key === key);
  if (rec && !rec.closedAt) {
    rec.closedAt = new Date().toISOString();
    writeIndex(ix);
    scheduleScan(folder, 1000); // the count in the status bar has just changed
  }
}

function closeAllStale(folder: string): void {
  const ix = readIndex(folder);
  let touched = false;
  for (const t of ix.terminals) {
    if (!t.closedAt) {
      t.closedAt = t.lastSeen;
      touched = true;
    }
  }
  if (touched) {
    writeIndex(ix);
  }
}

async function pidOf(term: vscode.Terminal): Promise<number | null> {
  try {
    const pid = await term.processId;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function cwdOf(term: vscode.Terminal): string | undefined {
  const opts = term.creationOptions as vscode.TerminalOptions;
  const cwd = opts?.cwd;
  if (!cwd) {
    return undefined;
  }
  return typeof cwd === 'string' ? cwd : cwd.fsPath;
}

/**
 * Keyed on pid, not name: two terminals are routinely both called "powershell",
 * and a name can be changed at any time. The pid is unique for the window's
 * lifetime, which is exactly how long a record needs to stay matched.
 */
function keyFor(term: vscode.Terminal, pid: number): string {
  return `${pid}:${term.creationOptions && 'shellPath' in term.creationOptions ? term.creationOptions.shellPath ?? '' : ''}`;
}

// --------------------------------------------------------------- restore ----

interface Choice extends vscode.QuickPickItem {
  rec: TerminalRecord;
}

/**
 * The keys of the terminals on screen right now. A terminal the current scan
 * has not reached yet is keyed directly from its pid, so this is usable before
 * the first scan and costs nothing: `processId` is already known to VS Code.
 */
async function openKeysNow(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const t of vscode.window.terminals) {
    const known = liveKeys.get(t);
    if (known) {
      keys.add(known);
      continue;
    }
    const pid = await pidOf(t);
    if (pid !== null) {
      keys.add(keyFor(t, pid));
    }
  }
  return keys;
}

async function restoreTerminals(folder: string): Promise<void> {
  const candidates = restorable(readIndex(folder), await openKeysNow());

  if (!candidates.length) {
    void vscode.window.showInformationMessage('Visual Impression: nothing recorded to bring back for this project yet.');
    return;
  }

  const items: Choice[] = candidates.map((rec) => {
    const p = rec.session ? getPreview(rec.app, rec.session, rec.cwd) : null;
    const title = p?.title ?? rec.title;
    const detail = p?.lastPrompt
      ? '> ' + oneLine(p.lastPrompt)
      : rec.app === 'shell' && rec.lastCommand
        ? '$ ' + oneLine(rec.lastCommand)
        : rec.session
          ? ''
          : noSessionNote(rec.app);
    return {
      rec,
      label: `$(${iconFor(rec.app)}) ${title ?? rec.name}`,
      description: `${rec.app}  ·  ${ago(rec.closedAt!)}`,
      detail,
      // Everything is pre-checked: Enter alone brings the project back, which
      // is the whole point. A plain shell among them is harmless -- it opens
      // in the right folder and runs nothing.
      picked: true,
    };
  });

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Restore terminals',
    placeHolder: 'Pick the conversations to bring back',
    matchOnDetail: true,
  });
  if (!picked?.length) {
    return;
  }
  const spare = await spareTerminals(folder);
  // The arrangement read off the screen before this project last closed, if
  // there is one: it decides which conversations share a tab, and in what
  // order. Without it they are grouped by the setting instead.
  const tabs = readIndex(folder).layout?.tabs ?? [];
  const { order, plan } = planByLayout(
    picked.map((c) => c.rec.key),
    tabs,
    spare.length,
    cfg<TabSizes>('restoreTerminalsPerTab', 3),
  );
  const opened: vscode.Terminal[] = [];
  order.forEach((pick, i) => {
    const where = plan[i];
    opened[i] = openFor(
      picked[pick].rec,
      where.kind === 'reuse' ? spare.shift() : undefined,
      where.kind === 'split' ? opened[where.parent] : undefined,
    );
  });
  scheduleScan(folder, 4000);
}

/**
 * Terminals VS Code revived by itself: plain shells in this project with no
 * agent in them. These are the ones sitting in the original split layout, so
 * resuming into one keeps the arrangement instead of adding another tab
 * beside it.
 */
async function spareTerminals(folder: string): Promise<vscode.Terminal[]> {
  if (!cfg('reuseRevivedTerminals', true)) {
    return [];
  }
  const out: vscode.Terminal[] = [];
  for (const t of vscode.window.terminals) {
    if (t.exitStatus) {
      continue;
    }
    const pid = await pidOf(t);
    if (pid === null) {
      continue;
    }
    const r = await resolveTerminal(pid, cwdOf(t) ?? folder);
    if (r.app === 'shell') {
      out.push(t);
    }
  }
  return out;
}

/**
 * `splitOf` puts the new terminal in the same tab as an earlier restored one,
 * which is the only layout control the API offers: a terminal can be created
 * beside a given parent, but no terminal can be asked which tab it is in.
 */
function openFor(
  rec: TerminalRecord,
  reuse?: vscode.Terminal,
  splitOf?: vscode.Terminal,
): vscode.Terminal {
  const term =
    reuse ??
    vscode.window.createTerminal({
      name: rec.title ?? rec.name,
      cwd: rec.cwd,
      ...(splitOf ? { location: { parentTerminal: splitOf } } : {}),
    });
  term.show(false);
  const cmd = resumeCommand(rec);
  if (cmd) {
    term.sendText(cmd, true);
    return term;
  }
  // A plain shell: put the command back on the prompt WITHOUT running it.
  // Reopening a window must never re-run a deploy, a migration or an rm.
  if (rec.lastCommand) {
    term.sendText(rec.lastCommand, false);
  }
  return term;
}

/**
 * With a session id the conversation reopens directly. Without one, the agent
 * is still started -- its own picker is the right fallback, and is what the
 * terminal-side tool does too.
 */
function resumeCommand(rec: TerminalRecord): string | null {
  if (rec.app === 'claude') {
    return rec.session ? `claude --resume ${rec.session}` : 'claude --resume';
  }
  if (rec.app === 'codex') {
    return rec.session ? `codex resume ${rec.session}` : 'codex resume';
  }
  return null;
}

function noSessionNote(app: App): string {
  if (app === 'codex') {
    return "no session id recorded — reopening gives you codex's own picker";
  }
  if (app === 'claude') {
    return "no session id recorded — reopening gives you claude's own picker";
  }
  return 'a plain shell';
}

function iconFor(app: App): string {
  return app === 'shell' ? 'terminal' : 'comment-discussion';
}

async function offerRestoreOnStartup(folder: string): Promise<void> {
  if (!cfg('promptOnStartup', true)) {
    return;
  }
  const n = restorable(readIndex(folder), await openKeysNow()).filter((t) => t.app !== 'shell').length;
  if (!n) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `Visual Impression: ${n} agent terminal${n === 1 ? '' : 's'} recorded in this project.`,
    'Restore…',
    'Not now',
    "Don't ask again",
  );
  if (pick === 'Restore…') {
    await restoreTerminals(folder);
  } else if (pick === "Don't ask again") {
    await vscode.workspace
      .getConfiguration('visualImpression')
      .update('promptOnStartup', false, vscode.ConfigurationTarget.Global);
  }
}

// ----------------------------------------------------------------- layout ----

/** The terminal set the last successful reading covered, to not repeat it. */
let probedKeys: string[] = [];
let probedAt = 0;
/** A reading older than this is re-taken: panes can be dragged, silently. */
const LAYOUT_STALE_MS = 900_000;

/**
 * Read which terminals share a tab and write it into the index, so that
 * reopening the project can rebuild the arrangement rather than guess at it.
 *
 * `quiet` is the automatic pass, taken when the window loses focus. It is
 * skipped unless there is an active terminal to put focus back on, because
 * the walk would otherwise pop the panel open on a window nobody is looking
 * at.
 */
async function rememberLayout(folder: string, quiet: boolean): Promise<void> {
  const mode = cfg<string>('rememberLayout', 'onBlur');
  if (mode === 'off' || (quiet && mode !== 'onBlur')) {
    return;
  }
  const before = vscode.window.activeTerminal;
  if (quiet && !before) {
    return;
  }
  if (vscode.window.terminals.length < 2) {
    return;
  }

  const byKey = new Map<string, vscode.Terminal>();
  for (const t of vscode.window.terminals) {
    const pid = await pidOf(t);
    if (pid !== null) {
      byKey.set(liveKeys.get(t) ?? keyFor(t, pid), t);
    }
  }
  const ids = [...byKey.keys()];
  if (ids.length < 2) {
    return;
  }
  if (quiet && sameTerminals(ids, probedKeys) && Date.now() - probedAt < LAYOUT_STALE_MS) {
    return;
  }

  const keyOf = (t: vscode.Terminal | undefined): string | undefined => {
    for (const [k, v] of byKey) {
      if (v === t) {
        return k;
      }
    }
    return undefined;
  };
  const probe: PaneProbe = {
    ids,
    activate: async (id) => {
      byKey.get(id)?.show(false);
      await settled();
    },
    next: async () => {
      await vscode.commands.executeCommand('workbench.action.terminal.focusNextPane');
      await settled();
    },
    active: () => keyOf(vscode.window.activeTerminal),
  };

  let tabs: string[][];
  try {
    tabs = await probeGroups(probe);
  } finally {
    before?.show(false); // put focus back where the walk found it
  }

  const ix = readIndex(folder);
  ix.layout = { tabs, at: new Date().toISOString() };
  writeIndex(ix);
  probedKeys = ids;
  probedAt = Date.now();

  if (!quiet) {
    const shape = tabs.map((t) => t.length).join(' + ');
    void vscode.window.showInformationMessage(
      `Visual Impression: remembered ${tabs.length} tab${tabs.length === 1 ? '' : 's'} (${shape} pane${ids.length === 1 ? '' : 's'}).`,
    );
  }
}

/**
 * Focus moves through an event, not through the command's promise, so each
 * step waits for the active terminal to actually change.
 */
function settled(ms = 120): Promise<void> {
  return new Promise((resolve) => {
    const done = vscode.window.onDidChangeActiveTerminal(() => {
      done.dispose();
      clearTimeout(timeout);
      resolve();
    });
    const timeout = setTimeout(() => {
      done.dispose();
      resolve();
    }, ms);
  });
}

// ---------------------------------------------------------------- status ----

async function showStatus(folder: string): Promise<void> {
  await scan(folder);
  const ix = readIndex(folder);
  const lines: string[] = [`# Visual Impression`, '', folder, ''];

  const live = ix.terminals.filter((t) => !t.closedAt);
  const gone = ix.terminals
    .filter((t) => t.closedAt)
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));

  lines.push('## Open now', '');
  lines.push(...(live.length ? live.map((t) => row(t)) : ['(none)']));
  lines.push('', '## Recoverable', '');
  lines.push(...(gone.length ? gone.map((t) => row(t)) : ['(none)']));
  if (ix.layout?.tabs.length) {
    lines.push(
      '',
      '## Arrangement',
      '',
      `${ix.layout.tabs.length} tab(s), ${ix.layout.tabs.map((t) => t.length).join(' + ')} pane(s), read ${ago(ix.layout.at)}`,
    );
  }
  lines.push('', '---', '', `Index: ${indexPath(folder)}`);

  const doc = await vscode.workspace.openTextDocument({
    content: lines.join('\n'),
    language: 'markdown',
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

function row(t: TerminalRecord): string {
  const p = t.session ? getPreview(t.app, t.session, t.cwd) : null;
  const title = p?.title ?? t.title ?? t.name;
  const when = t.closedAt ? `closed ${ago(t.closedAt)}` : 'open';
  const parts = [`- **[${t.app}]** ${title} — _${when}_`];
  if (p?.lastPrompt) {
    parts.push(`  - › ${oneLine(p.lastPrompt, 140)}`);
  }
  if (p?.lastReply) {
    parts.push(`  - ‹ ${oneLine(p.lastReply, 140)}`);
  }
  if (t.app === 'shell' && t.lastCommand) {
    parts.push(`  - $ ${oneLine(t.lastCommand, 140)}`);
  }
  if (!t.session && t.app !== 'shell') {
    parts.push(`  - ${noSessionNote(t.app)}`);
  }
  return parts.join('\n');
}

async function forgetWorkspace(folder: string): Promise<void> {
  const yes = await vscode.window.showWarningMessage(
    'Delete the recorded history for this project? Open terminals are recorded again on the next scan.',
    { modal: true },
    'Delete',
  );
  if (yes === 'Delete') {
    deleteIndex(folder);
    void vscode.window.showInformationMessage('Visual Impression: history cleared.');
  }
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return 'unknown';
  }
  const m = Math.floor(ms / 60000);
  if (m < 60) {
    return `${Math.max(0, m)}m ago`;
  }
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}
