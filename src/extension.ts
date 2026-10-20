// windoalls for VS Code.
//
// VS Code already restores the shell in a terminal. What it cannot restore is
// the conversation that was running in it, because only the agent knows that
// and only this window knows which terminal was which. So: record the pairing
// while the window is open, and offer it back when the project is reopened.

import * as vscode from 'vscode';
import { App, TerminalRecord, indexPath, pruneHistory, deleteIndex, readIndex, writeIndex } from './store';
import { invalidateProcessCache } from './procs';
import { invalidateRolloutCache, resolveTerminal } from './resolve';
import { getPreview, oneLine } from './preview';

/** Terminals this window created, so a scan can tell them from a stale record. */
const liveKeys = new WeakMap<vscode.Terminal, string>();
let timer: NodeJS.Timeout | undefined;
let scanning = false;

export function activate(context: vscode.ExtensionContext): void {
  const folder = workspaceFolder();
  if (!folder) {
    return; // no folder open: nothing to key an index to
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('windoalls.restoreTerminals', () => restoreTerminals(folder)),
    vscode.commands.registerCommand('windoalls.showStatus', () => showStatus(folder)),
    vscode.commands.registerCommand('windoalls.forgetWorkspace', () => forgetWorkspace(folder)),
    vscode.window.onDidOpenTerminal(() => scheduleScan(folder, 2500)),
    vscode.window.onDidCloseTerminal((t) => onClosed(folder, t)),
    vscode.window.onDidChangeActiveTerminal(() => scheduleScan(folder, 1500)),
    { dispose: () => timer && clearTimeout(timer) },
  );

  // Mark anything still open from the previous run as closed: the window is
  // starting, so by definition none of it survived.
  closeAllStale(folder);

  void offerRestoreOnStartup(folder);
  startPolling(folder, context);
  scheduleScan(folder, 3000);
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
  return vscode.workspace.getConfiguration('windoalls').get<T>(key) ?? fallback;
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
    }

    // Anything in the index that is not on screen has gone.
    for (const t of ix.terminals) {
      if (!t.closedAt && !seen.has(t.key)) {
        t.closedAt = now;
      }
    }

    pruneHistory(ix, cfg('historyDays', 14));
    writeIndex(ix);
  } catch {
    /* recording is best effort; never surface an error for it */
  } finally {
    scanning = false;
  }
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

async function restoreTerminals(folder: string): Promise<void> {
  const ix = readIndex(folder);
  const openKeys = new Set<string>();
  for (const t of vscode.window.terminals) {
    const k = liveKeys.get(t);
    if (k) {
      openKeys.add(k);
    }
  }

  const candidates = ix.terminals
    .filter((t) => t.closedAt && !openKeys.has(t.key))
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));

  if (!candidates.length) {
    void vscode.window.showInformationMessage('windoalls: nothing recorded to bring back for this project yet.');
    return;
  }

  const items: Choice[] = candidates.map((rec) => {
    const p = rec.session ? getPreview(rec.app, rec.session, rec.cwd) : null;
    const title = p?.title ?? rec.title;
    const detail = p?.lastPrompt ? '> ' + oneLine(p.lastPrompt) : rec.session ? '' : noSessionNote(rec.app);
    return {
      rec,
      label: `$(${iconFor(rec.app)}) ${title ?? rec.name}`,
      description: `${rec.app}  ·  ${ago(rec.closedAt!)}`,
      detail,
      picked: rec.app !== 'shell',
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
  for (const choice of picked) {
    openFor(choice.rec);
  }
  scheduleScan(folder, 4000);
}

function openFor(rec: TerminalRecord): void {
  const term = vscode.window.createTerminal({ name: rec.title ?? rec.name, cwd: rec.cwd });
  term.show(false);
  const cmd = resumeCommand(rec);
  if (cmd) {
    term.sendText(cmd, true);
  }
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
  const ix = readIndex(folder);
  const n = ix.terminals.filter((t) => t.closedAt && t.app !== 'shell').length;
  if (!n) {
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    `windoalls: ${n} agent terminal${n === 1 ? '' : 's'} recorded in this project.`,
    'Restore…',
    'Not now',
    "Don't ask again",
  );
  if (pick === 'Restore…') {
    await restoreTerminals(folder);
  } else if (pick === "Don't ask again") {
    await vscode.workspace
      .getConfiguration('windoalls')
      .update('promptOnStartup', false, vscode.ConfigurationTarget.Global);
  }
}

// ---------------------------------------------------------------- status ----

async function showStatus(folder: string): Promise<void> {
  await scan(folder);
  const ix = readIndex(folder);
  const lines: string[] = [`# windoalls`, '', folder, ''];

  const live = ix.terminals.filter((t) => !t.closedAt);
  const gone = ix.terminals
    .filter((t) => t.closedAt)
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!));

  lines.push('## Open now', '');
  lines.push(...(live.length ? live.map((t) => row(t)) : ['(none)']));
  lines.push('', '## Recoverable', '');
  lines.push(...(gone.length ? gone.map((t) => row(t)) : ['(none)']));
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
  if (!t.session && t.app !== 'shell') {
    parts.push(`  - ${noSessionNote(t.app)}`);
  }
  return parts.join('\n');
}

async function forgetWorkspace(folder: string): Promise<void> {
  const yes = await vscode.window.showWarningMessage(
    'Delete windoalls history for this project? Open terminals are recorded again on the next scan.',
    { modal: true },
    'Delete',
  );
  if (yes === 'Delete') {
    deleteIndex(folder);
    void vscode.window.showInformationMessage('windoalls: history cleared.');
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
