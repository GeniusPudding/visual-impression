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

/**
 * The line typed into the terminal. Ids are validated, so only the prompt needs quoting. With
 * `inlineReset` the terminal reset rides on the same line (a terminal without shell integration,
 * where nobody will hear the agent exit); without it the line is the agent's alone.
 */
export function handoffCommand(req: HandoffRequest, shell: ShellKind, inlineReset = true): string {
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
  return parts.join(' ') + (inlineReset ? resetAfter(shell) : '');
}

/**
 * The line that reopens a conversation in a restored terminal. Without a session id the agent
 * is still started -- its own picker is the right fallback, and is what the terminal-side tool
 * does too.
 */
export function resumeCommand(app: 'claude' | 'codex', session: string | undefined, shell: ShellKind, inlineReset = true): string {
  const line = app === 'claude' ? `claude --resume${session ? ' ' + session : ''}` : `codex resume${session ? ' ' + session : ''}`;
  return line + (inlineReset ? resetAfter(shell) : '');
}

// Terminal modes a full-screen agent switches on and a shell cannot live with: the alternate
// screen, mouse and focus reporting (X10, button, any-motion, focus, SGR, urxvt), win32-input-mode,
// bracketed paste, the kitty keyboard protocol; the cursor is shown again last. Each is harmless
// when it was never on.
const MODES_OFF = ['?1049l', '?1000l', '?1002l', '?1003l', '?1004l', '?1006l', '?1015l', '?9001l', '?2004l', '<u', '?25h'];

/**
 * The command that switches those modes off, on its own line. The agent restores the terminal
 * itself only on a clean exit; after a crash or a kill the shell that takes the terminal over
 * prints every mouse move as `[<35;10;1M`. With shell integration the extension hears the agent
 * exit and types this then, and only when the exit was not clean -- so the agent's own line stays
 * readable and nothing is typed when nothing is wrong.
 */
export function resetCommand(shell: ShellKind): string {
  if (shell === 'powershell') {
    // In a double-quoted PowerShell string `$e[` is the variable followed by a bracket, not an index.
    return `$e=[char]27; [Console]::Write("${MODES_OFF.map((m) => '$e[' + m).join('')}")`;
  }
  if (shell === 'cmd') {
    // Double-quoted for cmd, where a bare `<` (in the kitty pop) would be a redirection.
    return `powershell -NoProfile -Command "[Console]::Write(${MODES_OFF.map((m) => `[char]27+'[${m}'`).join('+')})"`;
  }
  return `printf '${MODES_OFF.map((m) => '\\033[' + m).join('')}'`;
}

/**
 * The same reset appended to the agent's own command line, for a terminal without shell
 * integration: nobody will hear the agent exit there, so the line that started it is the only
 * party left to switch the modes off.
 */
export function resetAfter(shell: ShellKind): string {
  return (shell === 'cmd' ? ' & ' : '; ') + resetCommand(shell);
}

/** Whether an exit the shell reported calls for the reset: anything but a clean 0, the unknown included. */
export function needsReset(exitCode: number | undefined): boolean {
  return exitCode !== 0;
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
