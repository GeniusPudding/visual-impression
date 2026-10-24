// Open an agent for a ticket, on request from outside VS Code.
//
// Another program (the owner's assistant hub) asks, through the extension's
// URI, for a terminal in a given folder that starts Claude Code or Codex --
// fresh, or resuming a known conversation -- with a first prompt. The URI
// never carries a command: only an agent name, ids and a prompt, and the
// command is assembled here from those. So a link can start one of two
// programs with a prompt the owner will see, and nothing else.

import { normalisePath } from './resolve';

export type HandoffAgent = 'claude' | 'codex';
export type ShellKind = 'powershell' | 'cmd' | 'posix';

export interface HandoffRequest {
  cwd: string;
  agent: HandoffAgent;
  /** The ticket the terminal is for; exported as ASSISTANT_HUB_TASK. */
  task?: string;
  /** The development line it is for; exported as ASSISTANT_HUB_PROJECT. */
  project?: string;
  /** A conversation to resume, or (Claude Code only) the id to start under. */
  session?: string;
  resume: boolean;
  prompt?: string;
  title?: string;
}

const TASK = /^T-[a-f0-9]+$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const SESSION = /^[A-Za-z0-9-]{8,64}$/;
const PROMPT_MAX = 500;

/** The request a `/handoff` URI carries, or null when any part of it is off. */
export function parseHandoff(query: string): HandoffRequest | null {
  const q = new URLSearchParams(query);
  const cwd = q.get('cwd') ?? '';
  const agent = q.get('agent') ?? 'claude';
  const task = q.get('task') ?? undefined;
  const project = q.get('project') ?? undefined;
  const session = q.get('session') || undefined;
  const prompt = q.get('prompt') ?? undefined;
  const title = q.get('title') ?? undefined;
  if (!cwd.trim() || (agent !== 'claude' && agent !== 'codex')) {
    return null;
  }
  if ((task !== undefined && !TASK.test(task)) || (session !== undefined && !SESSION.test(session))) {
    return null;
  }
  if (project !== undefined && !PROJECT.test(project)) {
    return null;
  }
  // A prompt is one line the owner will see typed; control characters have no place in it.
  if (prompt !== undefined && (prompt.length > PROMPT_MAX || [...prompt].some((ch) => ch.charCodeAt(0) < 32))) {
    return null;
  }
  const resume = q.get('resume') === '1' || q.get('resume') === 'true';
  if (resume && !session) {
    return null;
  }
  return {
    cwd,
    agent,
    task,
    project,
    session,
    resume,
    prompt: prompt?.trim() || undefined,
    title: title?.trim().slice(0, 80) || undefined,
  };
}

/** The variables the hub's hook reads to bind the conversation to its ticket or project. */
export function handoffEnv(req: HandoffRequest): Record<string, string> {
  const env: Record<string, string> = {};
  if (req.task) {
    env.ASSISTANT_HUB_TASK = req.task;
  }
  if (req.project) {
    env.ASSISTANT_HUB_PROJECT = req.project;
  }
  return env;
}

/** One argument, quoted for the shell the terminal runs. */
export function quoteFor(text: string, shell: ShellKind): string {
  if (shell === 'powershell') {
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (shell === 'cmd') {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The line typed into the terminal. Ids are validated, so only the prompt needs quoting. */
export function handoffCommand(req: HandoffRequest, shell: ShellKind): string {
  const parts: string[] = [];
  if (req.agent === 'claude') {
    parts.push('claude');
    if (req.resume && req.session) {
      parts.push('--resume', req.session);
    } else if (req.session) {
      parts.push('--session-id', req.session);
    }
  } else {
    parts.push('codex');
    if (req.resume && req.session) {
      parts.push('resume', req.session);
    }
  }
  if (req.prompt) {
    parts.push(quoteFor(req.prompt, shell));
  }
  return parts.join(' ');
}

/** Which quoting a shell wants, from its executable path. */
export function shellKindOf(shellPath: string | undefined): ShellKind {
  const base = (shellPath ?? '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (base.startsWith('pwsh') || base.startsWith('powershell')) {
    return 'powershell';
  }
  if (base === 'cmd.exe' || base === 'cmd') {
    return 'cmd';
  }
  return 'posix';
}

/** Whether the request is for the folder this window has open. */
export function sameFolder(a: string | undefined, b: string): boolean {
  return a !== undefined && normalisePath(slashes(a)) === normalisePath(slashes(b));
}

// Windows accepts either separator and the two sides of a comparison may use
// different ones; elsewhere a backslash is an ordinary character in a name.
function slashes(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

/** A request parked for the window that opens the folder; stale after this long. */
export const PENDING_HANDOFF_MS = 120_000;
export const PENDING_HANDOFF_KEY = 'visualImpression.pendingHandoff';

export interface PendingHandoff extends HandoffRequest {
  at: number;
}

export function pendingFor(
  pending: PendingHandoff | undefined,
  folder: string | undefined,
  now = Date.now(),
): HandoffRequest | null {
  if (!pending || now - pending.at > PENDING_HANDOFF_MS || !sameFolder(folder, pending.cwd)) {
    return null;
  }
  return pending;
}
