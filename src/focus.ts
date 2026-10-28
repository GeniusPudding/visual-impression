// Bring a conversation's terminal to the front, on request from outside VS Code.
//
// Another program (the owner's attention strip) knows which conversation
// finished and which VS Code window it is in, but a window is a stack of
// terminal tabs and only this extension can say which tab holds the
// conversation -- so it asks, through the extension's URI, and the extension
// shows that terminal. The link names a conversation, a shell pid or a
// terminal name; it can show a terminal that exists and nothing else.

import type { TerminalRecord } from './store';
import { sameFolder } from './handoff';

export interface FocusRequest {
  /** The conversation id: a Claude Code session, or a Codex thread (`codex:` prefix tolerated). */
  session?: string;
  /** The terminal's shell pid, as the index keys it. */
  pid?: number;
  /** The terminal's name, for a terminal the index never matched to a conversation. */
  name?: string;
  /** The folder the terminal's window has open, so a request landing elsewhere can find it. */
  cwd?: string;
}

const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const NAME_MAX = 80;

/** The request a `/focus` URI carries, or null when it names nothing, or names it badly. */
export function parseFocus(query: string): FocusRequest | null {
  const q = new URLSearchParams(query);
  const rawSession = (q.get('session') ?? '').trim();
  const session = rawSession.replace(/^codex:/, '');
  const pidText = (q.get('pid') ?? '').trim();
  const name = (q.get('name') ?? '').trim();
  const cwd = (q.get('cwd') ?? '').trim();
  if (session && !SESSION.test(session)) {
    return null;
  }
  if (pidText && !/^\d{1,9}$/.test(pidText)) {
    return null;
  }
  if (name && (name.length > NAME_MAX || [...name].some((ch) => ch.charCodeAt(0) < 32))) {
    return null;
  }
  if (!session && !pidText && !name) {
    return null;
  }
  const req: FocusRequest = {};
  if (session) {
    req.session = session;
  }
  if (pidText) {
    req.pid = Number(pidText);
  }
  if (name) {
    req.name = name;
  }
  if (cwd) {
    req.cwd = cwd;
  }
  return req;
}

/**
 * The key of the open terminal the request means, or null. The conversation
 * id is exact; the shell pid is exact; a name is only good enough when exactly
 * one open terminal carries it. A closed record is never an answer: a lamp
 * leads to a terminal that is there.
 */
export function pickTerminalKey(records: TerminalRecord[], openKeys: Set<string>, req: FocusRequest): string | null {
  const open = records.filter((t) => !t.closedAt && openKeys.has(t.key));
  if (req.session) {
    const hit = open.find((t) => t.session === req.session);
    if (hit) {
      return hit.key;
    }
  }
  if (req.pid !== undefined) {
    const hit = open.find((t) => t.shellPid === req.pid);
    if (hit) {
      return hit.key;
    }
  }
  if (req.name) {
    const named = open.filter((t) => t.name === req.name);
    if (named.length === 1) {
      return named[0].key;
    }
  }
  return null;
}

/** A request parked for the window that holds the terminal; stale after this long. */
export const PENDING_FOCUS_MS = 20_000;
export const PENDING_FOCUS_KEY = 'visualImpression.pendingFocus';

export interface PendingFocus extends FocusRequest {
  at: number;
}

/**
 * Whether a parked request is still worth acting on here: fresh, and either
 * naming this window's folder or naming no folder at all (then every window
 * tries, and the one that has the terminal is the one that finds it).
 */
export function focusPending(pending: PendingFocus | undefined, folder: string | undefined, now = Date.now()): FocusRequest | null {
  if (!pending || now - pending.at > PENDING_FOCUS_MS) {
    return null;
  }
  if (pending.cwd && !sameFolder(folder, pending.cwd)) {
    return null;
  }
  const req: FocusRequest & Partial<PendingFocus> = { ...pending };
  delete req.at;
  return req;
}
