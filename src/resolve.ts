// Which conversation is this terminal driving?
//
// The terminal-side matcher in bin\wt-snapshot-scan.ps1 has to DROP every
// rollout marked `source: vscode`, because those belong to a window it cannot
// see into. Here the test is exactly inverted: this extension IS that window,
// so `source: vscode` is the signal rather than the disqualifier.
//
// Everything else carries over, including the rule that an ambiguous match
// records nothing. Resuming the wrong conversation is far worse than offering
// the agent's own picker.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App } from './store';
import { Proc, descendants, listProcesses } from './procs';

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

export interface Resolved {
  app: App;
  session: string | null;
  title: string | null;
}

export async function resolveTerminal(
  shellPid: number,
  cwd: string,
  claimed: ReadonlySet<string> = new Set(),
): Promise<Resolved> {
  const procs = await listProcesses();
  const kids = descendants(procs, shellPid);

  const claude = kids.find(isClaude);
  if (claude) {
    const m = readClaudeSession(claude.pid);
    return { app: 'claude', session: m?.sessionId ?? fromCommandLine(claude), title: m?.name ?? null };
  }

  const codex = kids.find(isCodex);
  if (codex) {
    return { app: 'codex', session: resolveCodex(codex, cwd, claimed), title: null };
  }

  return { app: 'shell', session: null, title: null };
}

function isClaude(p: Proc): boolean {
  if (/^claude(\.exe)?$/i.test(p.name)) {
    return true;
  }
  return /\bnode(\.exe)?$/i.test(p.name) && /[\\/]claude(-code)?[\\/]/i.test(p.commandLine);
}

function isCodex(p: Proc): boolean {
  if (/^codex(\.exe)?$/i.test(p.name)) {
    return true;
  }
  return /\bnode(\.exe)?$/i.test(p.name) && /[\\/]codex[\\/]/i.test(p.commandLine);
}

function fromCommandLine(p: Proc): string | null {
  const m = UUID.exec(p.commandLine);
  return m ? m[0] : null;
}

// ----------------------------------------------------------------- claude --

interface ClaudeSession {
  pid: number;
  sessionId: string;
  cwd: string;
  name?: string;
  updatedAt?: number;
  status?: string;
}

/** Claude publishes a live pid -> session map. When it is there, it is the truth. */
function readClaudeSession(pid: number): ClaudeSession | null {
  try {
    const file = path.join(os.homedir(), '.claude', 'sessions', `${pid}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ClaudeSession;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ codex --

export interface Rollout {
  file: string;
  sessionId: string;
  cwd: string;
  source: string;
  started: number;
  modified: number;
}

let rolloutCache: { at: number; rows: Rollout[] } | null = null;
const metaCache = new Map<string, Rollout | null>();

/** session_meta never changes once written, so it is parsed once per file. */
export function listRollouts(maxAgeMs = 4000): Rollout[] {
  if (rolloutCache && Date.now() - rolloutCache.at < maxAgeMs) {
    return rolloutCache.rows;
  }
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const rows: Rollout[] = [];
  for (const file of walk(root, 5)) {
    if (!/rollout-.*\.jsonl$/i.test(file)) {
      continue;
    }
    let meta = metaCache.get(file);
    if (meta === undefined) {
      meta = readMeta(file);
      metaCache.set(file, meta);
    }
    if (!meta) {
      continue;
    }
    let modified = meta.modified;
    try {
      modified = fs.statSync(file).mtimeMs;
    } catch {
      /* vanished between the walk and the stat */
    }
    rows.push({ ...meta, modified });
  }
  rolloutCache = { at: Date.now(), rows };
  return rows;
}

export function invalidateRolloutCache(): void {
  rolloutCache = null;
}

/**
 * The first line, however long it is. session_meta carries the whole
 * environment context and routinely runs past 20 KB, so a fixed buffer finds
 * no newline and silently discards every rollout.
 */
function readFirstLine(fd: number, cap = 1024 * 1024): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < cap) {
    const buf = Buffer.alloc(Math.min(65536, cap - total));
    const read = fs.readSync(fd, buf, 0, buf.length, total);
    if (read <= 0) {
      break;
    }
    chunks.push(buf.subarray(0, read));
    total += read;
    // Concatenate before decoding: a multi-byte character can straddle the
    // boundary between two chunks.
    const text = Buffer.concat(chunks).toString('utf8');
    const nl = text.indexOf('\n');
    if (nl >= 0) {
      return text.slice(0, nl);
    }
  }
  return null;
}

function readMeta(file: string): Rollout | null {
  try {
    // The first line only. These reach tens of megabytes, and session_meta is
    // always the first record.
    const fd = fs.openSync(file, 'r');
    try {
      const line = readFirstLine(fd);
      if (!line) {
        return null;
      }
      const o = JSON.parse(line) as {
        type?: string;
        payload?: { session_id?: string; cwd?: string; source?: unknown; timestamp?: string };
      };
      const p = o.payload;
      if (o.type !== 'session_meta' || !p?.session_id) {
        return null;
      }
      return {
        file,
        sessionId: p.session_id,
        cwd: p.cwd ?? '',
        // `source` is a string for a real session and an object for a subagent
        source: typeof p.source === 'string' ? p.source : '',
        started: p.timestamp ? Date.parse(p.timestamp) : 0,
        modified: 0,
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function resolveCodex(proc: Proc, cwd: string, claimed: ReadonlySet<string>): string | null {
  // `codex resume <uuid>` states the answer outright.
  const explicit = fromCommandLine(proc);
  if (explicit) {
    return explicit;
  }
  return pickCodexRollout(listRollouts(), cwd, claimed);
}

/**
 * The matching rule, kept pure so it can be tested without a live process
 * table. `source` must be exactly 'vscode': a subagent records an object
 * there, and a plain Windows Terminal tab records something else -- both
 * belong to someone other than this terminal.
 *
 * Returns null rather than guessing. There is no process start time to lean
 * on here (VS Code does not report when a shell started), so the workspace
 * filter plus the claim set is the whole of the disambiguation, and a restore
 * into the agent's own picker beats a restore into the wrong conversation.
 */
export function pickCodexRollout(
  rows: readonly Rollout[],
  cwd: string,
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  const want = normalisePath(cwd);
  if (!want) {
    return null;
  }
  const cand = rows.filter(
    (r) => r.source === 'vscode' && normalisePath(r.cwd) === want && !claimed.has(r.sessionId),
  );
  if (!cand.length) {
    return null;
  }
  return [...cand].sort((a, b) => b.modified - a.modified)[0].sessionId;
}

/**
 * Windows compares paths case-insensitively; Linux does not. Folding case on
 * Linux would let a rollout from ~/src/Api be claimed by a terminal sitting
 * in ~/src/api, which is a different directory there.
 */
export function normalisePath(p: string, foldCase = process.platform === 'win32'): string {
  const trimmed = (p || '').replace(/[\\/]+$/, '');
  return foldCase ? trimmed.toLowerCase() : trimmed;
}

function walk(dir: string, depth: number): string[] {
  if (depth < 0) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walk(full, depth - 1));
    } else {
      out.push(full);
    }
  }
  return out;
}
