// The per-project index, on disk.
//
// This deliberately lives in a plain directory under the home directory,
// ~/.visual-impression, rather than in the extension's workspaceState. Two
// reasons: another tool can read it, so one command outside VS Code can still
// answer "where is all my work"; and a VS Code window that never reopens does
// not take its history with it. `visualImpression.stateDirectory` moves it.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type App = 'claude' | 'codex' | 'shell';

export interface TerminalRecord {
  /** Stable across scans: VS Code reuses neither name nor pid reliably. */
  key: string;
  name: string;
  cwd: string;
  shellPid: number | null;
  app: App;
  /** The agent conversation, when it could be established. */
  session: string | null;
  /** The agent's own name for the conversation, when it publishes one. */
  title: string | null;
  openedAt: string;
  lastSeen: string;
  closedAt: string | null;
  /** The last command run here, for a terminal that is not running an agent. */
  lastCommand: string | null;
  lastCommandAt: string | null;
  /** The agent process last seen in it; the same pid means the same conversation. */
  agentPid?: number | null;
  /**
   * When the shell process started, as the process table states it. A pid is
   * only an identity together with this: after a reboot a Linux host hands the
   * same small pids out again, and a new bash must not inherit the agent
   * conversation an earlier shell with that pid ran.
   */
  shellStarted?: string | null;
}

/** The arrangement of the panes, as last read off the screen. */
export interface LayoutRecord {
  /** Each tab's terminals, by record key, in pane order. */
  tabs: string[][];
  at: string;
}

export interface WorkspaceIndex {
  version: 1;
  folder: string;
  updatedAt: string;
  terminals: TerminalRecord[];
  /** Absent until a layout has been read; see layout.ts for why it is hard. */
  layout?: LayoutRecord;
}

/** Set from `visualImpression.stateDirectory`; empty means the default. */
let override = '';

export function setStateDir(dir: string): void {
  const trimmed = (dir || '').trim();
  override = trimmed.startsWith('~')
    ? path.join(os.homedir(), trimmed.slice(1))
    : trimmed;
}

export function stateDir(): string {
  return override || path.join(os.homedir(), '.visual-impression');
}

/**
 * Where this lived before the extension had a name of its own: beside the
 * Windows terminal tool it grew out of. Indexes found there are moved on
 * first use, once, rather than left behind for a tool to read as current.
 */
export function legacyStateDir(): string {
  return path.join(os.homedir(), '.wt-tabs', 'vscode');
}

/** Returns the path it moved, for the log line, or null if there was none. */
export function migrateLegacyIndex(folder: string): string | null {
  const from = path.join(legacyStateDir(), slugFor(folder) + '.json');
  const to = indexPath(folder);
  try {
    if (!fs.existsSync(from) || fs.existsSync(to)) {
      return null;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      // A different volume, or a lock: copying still leaves the index usable.
      fs.copyFileSync(from, to);
      fs.unlinkSync(from);
    }
    return from;
  } catch {
    return null;
  }
}

/**
 * Claude encodes a workspace path by replacing ':' and '\' with '-'. Reusing
 * exactly that means a human reading ~/.wt-tabs/vscode can line the files up
 * against ~/.claude/projects without a lookup table.
 */
export function slugFor(folder: string): string {
  return folder.replace(/[:\\/]/g, '-');
}

export function indexPath(folder: string): string {
  return path.join(stateDir(), slugFor(folder) + '.json');
}

export function readIndex(folder: string): WorkspaceIndex {
  const empty: WorkspaceIndex = {
    version: 1,
    folder,
    updatedAt: new Date().toISOString(),
    terminals: [],
  };
  try {
    const raw = fs.readFileSync(indexPath(folder), 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceIndex;
    if (!parsed || !Array.isArray(parsed.terminals)) {
      return empty;
    }
    parsed.folder = folder;
    return parsed;
  } catch {
    return empty;
  }
}

export function writeIndex(ix: WorkspaceIndex): void {
  ix.updatedAt = new Date().toISOString();
  const file = indexPath(ix.folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write-then-rename: `wts` may be reading this file at any moment, and a
  // half-written index reads as a corrupt one.
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(ix, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function pruneHistory(ix: WorkspaceIndex, days: number): void {
  const cutoff = Date.now() - days * 86400_000;
  ix.terminals = ix.terminals.filter((t) => {
    if (!t.closedAt) {
      return true;
    }
    const at = Date.parse(t.closedAt);
    return Number.isNaN(at) || at >= cutoff;
  });
}

/**
 * What `Restore terminals` may offer: closed records, minus anything whose
 * terminal is on screen right now, newest first.
 *
 * The second test is not redundant. A window reload reconnects its terminals
 * under their original pids, so a record is marked closed on activation and is
 * live again a moment later; offering that back would start a second agent on
 * a conversation already running in the terminal next door.
 */
/** Closes further apart than this were two separate decisions, not one. */
const BATCH_MS = 120_000;

/**
 * Newest group of closures first, and inside a group the order the terminals
 * were on screen.
 *
 * Sorting purely by close time looked right and was not: closing a window
 * stamps each terminal as its own event, milliseconds apart in whatever order
 * the shells happen to exit, so four panes came back shuffled. Those four
 * closures are one event. Within it the index order is the better answer --
 * records are appended in `window.terminals` order, which for terminals VS
 * Code revived is its own layout order, left to right.
 */
function orderForScreen(rows: { t: TerminalRecord; at: number }[]): TerminalRecord[] {
  const byTime = [...rows].sort(
    (a, b) => Date.parse(b.t.closedAt as string) - Date.parse(a.t.closedAt as string),
  );
  let batch = 0;
  let previous = Number.NaN;
  const grouped = byTime.map((r) => {
    const closed = Date.parse(r.t.closedAt as string);
    if (previous - closed > BATCH_MS) {
      batch++;
    }
    previous = closed;
    return { ...r, batch };
  });
  grouped.sort((a, b) => a.batch - b.batch || a.at - b.at);
  return grouped.map((r) => r.t);
}

/**
 * Records are keyed by the shell's pid and nothing else. Earlier builds appended
 * the shell path, which VS Code reports for a terminal it was asked to create
 * and not for one it revived after a reload -- so the same terminal came back
 * under a second key, and the index grew a twin of every plain shell.
 */
export function keyForPid(pid: number): string {
  return String(pid);
}

/** A week: longer than any reload, shorter than a pid is likely to come round again. */
const RELOAD_MS = 7 * 24 * 60 * 60_000;

function renameRecord(ix: WorkspaceIndex, rec: TerminalRecord, key: string): void {
  for (const tab of ix.layout?.tabs ?? []) {
    for (let i = 0; i < tab.length; i++) {
      if (tab[i] === rec.key) {
        tab[i] = key;
      }
    }
  }
  rec.key = key;
}

/**
 * The record a terminal on screen belongs to, or undefined for a terminal the
 * index has not met. Its own key first; failing that a record from before pids
 * were the whole key (`pid:shell path`), renamed so the next scan finds it
 * directly. A record is somebody else's -- pids come round again -- when it
 * was closed longer ago than a reload takes, or when it knows when its shell
 * started and the shell on screen started at another time; its key is then
 * moved aside so the new terminal can have it. `started` is the shell's start
 * as the process table states it, or undefined where it cannot be read.
 */
export function findRecord(
  ix: WorkspaceIndex,
  key: string,
  pid: number,
  nowMs: number,
  started?: string,
): TerminalRecord | undefined {
  const recent = (t: TerminalRecord): boolean =>
    !t.closedAt || nowMs - Date.parse(t.closedAt) <= RELOAD_MS;
  const sameProcess = (t: TerminalRecord): boolean => !started || !t.shellStarted || t.shellStarted === started;
  const exact = ix.terminals.find((t) => t.key === key);
  if (exact) {
    if (recent(exact) && sameProcess(exact)) {
      return exact;
    }
    // A record still marked open belonged to a shell that is gone without a
    // close being seen (the host went down): it closed when it was last seen.
    if (!exact.closedAt) {
      exact.closedAt = exact.lastSeen;
    }
    renameRecord(ix, exact, `${key}#${exact.closedAt}`);
  }
  const legacy = ix.terminals.filter((t) => t.key.startsWith(`${pid}:`) && recent(t) && sameProcess(t)).pop();
  if (legacy) {
    renameRecord(ix, legacy, key);
  }
  return legacy;
}

export function restorable(
  ix: WorkspaceIndex,
  openKeys: ReadonlySet<string> = new Set(),
): TerminalRecord[] {
  // A conversation that is running right now is not something to bring back,
  // whichever terminal happens to be holding it.
  const live = new Set(
    ix.terminals.filter((t) => !t.closedAt && t.session).map((t) => t.session as string),
  );
  const rows = orderForScreen(
    ix.terminals
      .map((t, at) => ({ t, at }))
      .filter(({ t }) => t.closedAt && !openKeys.has(t.key))
      // A shell that ran nothing has nothing to restore. VS Code revives those
      // itself, with their directory and their scrollback, and offering a
      // fourth empty prompt alongside is noise. The command is judged again
      // here, so a record written under an older rule drops out too.
      .filter(({ t }) => t.app !== 'shell' || (t.lastCommand && isWorthRecording(t.lastCommand)))
      .filter(({ t }) => !t.session || !live.has(t.session)),
  );

  // One row per conversation. Records are keyed by pid, so every reopen of
  // the window writes the same conversation again under a new key; the newest
  // is the one to offer, and offering the others would put several terminals
  // on one conversation. A plain shell is one row per folder and command for
  // the same reason: over SSH every restart of the remote server leaves a
  // fresh record of the same shell.
  const seen = new Set<string>();
  return rows.filter((t) => {
    const key = t.session
      ? `s:${t.session}`
      : t.app === 'shell'
        ? `p:${(t.cwd || '').replace(/[\\/]+$/, '').toLowerCase()}|${(t.lastCommand || '').trim()}`
        : null;
    if (!key) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Whether a command is worth putting back on the prompt when the terminal
 * returns. Navigation and screen-clearing are not: the restored terminal
 * already opens in the right directory, and offering `clear` back would only
 * displace something useful. The resume commands this extension itself sends
 * are skipped too, so a restore does not record itself.
 */
export function isWorthRecording(command: string): boolean {
  const trimmed = (command || '').trim();
  if (!trimmed || trimmed.length > 2000) {
    return false;
  }
  // ...including as they arrived when PowerShell swallowed the first byte (0.3.0),
  // and any command that names a conversation id: that is a resume, however spelt.
  if (/^(c?laude\s+(--resume|-c)|c?odex\s+resume)\b/i.test(trimmed)) {
    return false;
  }
  if (/(?:^|\s)(?:--resume|resume|--session-id)\s+[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) {
    return false;
  }
  const verb = trimmed.split(/\s+/)[0].toLowerCase();
  return !['cd', 'ls', 'll', 'dir', 'pwd', 'clear', 'cls', 'exit', 'logout'].includes(verb);
}

/** Where one restored conversation goes. */
export type Placement =
  /** Into a terminal VS Code revived by itself, which is already in a pane. */
  | { kind: 'reuse' }
  /** Into a terminal of its own, in a new tab. */
  | { kind: 'tab' }
  /** Split beside the previous restored one; `parent` indexes the same plan. */
  | { kind: 'split'; parent: number };

/**
 * How many panes each new tab gets. A single number repeats; a list gives the
 * tabs their own sizes, and its last entry repeats once the list runs out, so
 * `[2, 1]` is two, then one, then one, then one.
 */
export type TabSizes = number | number[];

function sizeOfTab(perTab: TabSizes, tab: number): number {
  if (typeof perTab === 'number') {
    return clampSize(perTab);
  }
  if (!perTab.length) {
    return 1;
  }
  return clampSize(perTab[Math.min(tab, perTab.length - 1)]);
}

function clampSize(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
}

/**
 * Where each chosen record goes, and in what order to open them.
 *
 * Reuse comes first and preserves the real layout: VS Code rebuilds the
 * arrangement from its own layout record when it revives terminals, so a
 * conversation resumed into one of those lands inside it.
 *
 * `tabs` is the arrangement read off the screen while the project was last
 * open (see layout.ts), by record key. It decides which conversations share
 * a tab and in what order, which is why the order to open them in is part of
 * the answer: the remembered arrangement, not the picker, settles that.
 * Records it says nothing about -- a conversation from an older session, or
 * one whose terminal was never read -- follow at the end in tabs of
 * `perTab`, which is also what happens when there is no reading at all.
 *
 * Each split names the pane before it, never the tab's first pane. VS Code
 * inserts a split immediately after its parent, so hanging everything off
 * the first pane builds the tab backwards: 1, 2, 3 comes out as 1, 3, 2.
 */
export function planByLayout(
  keys: readonly string[],
  tabs: readonly (readonly string[])[],
  spares: number,
  perTab: TabSizes = 3,
): { order: number[]; plan: Placement[] } {
  const slot = new Map<string, number[]>();
  keys.forEach((k, i) => {
    const q = slot.get(k);
    if (q) {
      q.push(i);
    } else {
      slot.set(k, [i]);
    }
  });
  const take = (k: string): number | undefined => slot.get(k)?.shift();

  const groups: number[][] = [];
  for (const tab of tabs) {
    const g: number[] = [];
    for (const k of tab) {
      const i = take(k);
      if (i !== undefined) {
        g.push(i);
      }
    }
    if (g.length) {
      groups.push(g);
    }
  }

  const placed = new Set(groups.flat());
  const rest = keys.map((_, i) => i).filter((i) => !placed.has(i));
  // Terminals being reused are already in a pane of their own, so they are
  // set aside before the remainder is cut into tabs -- otherwise a reused
  // one would take up a slot and leave a tab short.
  const spare = Math.max(0, Math.min(keys.length, Math.floor(spares)));
  const left = Math.max(0, spare - placed.size);
  if (left) {
    groups.push(rest.slice(0, left));
  }
  for (let i = left; i < rest.length; ) {
    const size = sizeOfTab(perTab, groups.length - (left ? 1 : 0));
    groups.push(rest.slice(i, i + size));
    i += size;
  }

  const order: number[] = [];
  const plan: Placement[] = [];
  let reused = 0;
  for (const g of groups) {
    let previous = -1; // the last pane in this tab that was actually opened
    for (const i of g) {
      order.push(i);
      if (reused < spare) {
        plan.push({ kind: 'reuse' });
        reused++;
      } else if (previous < 0) {
        plan.push({ kind: 'tab' });
        previous = plan.length - 1;
      } else {
        plan.push({ kind: 'split', parent: previous });
        previous = plan.length - 1;
      }
    }
  }
  return { order, plan };
}

/**
 * The arrangement a restore built itself, read off its own plan rather than
 * off the screen: the terminals opened as splits of one another share a tab.
 * `keys[i]` is the record key of the terminal opened for `plan[i]`, or
 * undefined if it never reported a pid. Reused terminals are left out --
 * their tab is one VS Code revived, and cannot be seen.
 *
 * This is what keeps a restored project's arrangement across the next close
 * and reopen without a walk, as long as nobody rearranged it by hand.
 */
export function layoutOfPlan(
  keys: readonly (string | undefined)[],
  plan: readonly Placement[],
): string[][] {
  const tabs: string[][] = [];
  const tabOf: number[] = []; // plan index -> index into tabs
  plan.forEach((where, i) => {
    if (where.kind === 'reuse') {
      return;
    }
    let tab = where.kind === 'split' ? tabOf[where.parent] : undefined;
    if (tab === undefined) {
      tab = tabs.push([]) - 1;
    }
    tabOf[i] = tab;
    const key = keys[i];
    if (key) {
      tabs[tab].push(key);
    }
  });
  return tabs.filter((t) => t.length);
}

/**
 * A fresh partial reading on top of an older one. The fresh tabs come first;
 * the old ones follow, trimmed to the terminals the index still knows, since
 * a tab that mentions nothing restorable is dead weight.
 */
export function mergeLayout(
  fresh: readonly (readonly string[])[],
  old: readonly (readonly string[])[],
  known: ReadonlySet<string>,
): string[][] {
  const mentioned = new Set(fresh.flat());
  const kept = old
    .map((tab) => tab.filter((k) => known.has(k) && !mentioned.has(k)))
    .filter((tab) => tab.length);
  return [...fresh.map((t) => [...t]), ...kept];
}

export function deleteIndex(folder: string): void {
  try {
    fs.unlinkSync(indexPath(folder));
  } catch {
    /* already gone */
  }
}
