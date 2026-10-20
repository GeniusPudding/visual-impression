// The per-project index, on disk.
//
// This deliberately lives next to the terminal tool's own state, under
// ~/.wt-tabs, rather than in the extension's workspaceState. Two reasons:
// `wts` can read it, so one command still answers "where is all my work"; and
// a VS Code window that never reopens does not take its history with it.

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
}

export interface WorkspaceIndex {
  version: 1;
  folder: string;
  updatedAt: string;
  terminals: TerminalRecord[];
}

export function stateDir(): string {
  return path.join(os.homedir(), '.wt-tabs', 'vscode');
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

export function deleteIndex(folder: string): void {
  try {
    fs.unlinkSync(indexPath(folder));
  } catch {
    /* already gone */
  }
}
