// Where did this conversation get to?
//
// A port of bin\wt-session-preview.ps1, with the same two lessons baked in:
// read the tail rather than the whole file, because transcripts reach tens of
// megabytes; and find a codex conversation by its session_meta, never by its
// file name, because every `codex resume` opens a new file whose name is a
// fresh uuid while the conversation keeps the original id.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App } from './store';
import { listRollouts } from './resolve';

export interface Preview {
  title: string | null;
  lastPrompt: string | null;
  lastReply: string | null;
  when: string | null;
  log: string;
}

export function getPreview(app: App, sessionId: string, cwd: string): Preview | null {
  if (!sessionId) {
    return null;
  }
  if (app === 'claude') {
    return claudePreview(sessionId, cwd);
  }
  if (app === 'codex') {
    return codexPreview(sessionId);
  }
  return null;
}

// ------------------------------------------------------------------ claude --

function findClaudeLog(sessionId: string, cwd: string): string | null {
  const root = path.join(os.homedir(), '.claude', 'projects');
  if (cwd) {
    const direct = path.join(root, cwd.replace(/[:\\/]/g, '-'), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) {
      return direct;
    }
  }
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`);
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

function claudePreview(sessionId: string, cwd: string): Preview | null {
  const log = findClaudeLog(sessionId, cwd);
  if (!log) {
    return null;
  }
  const objs = tail(log);
  let title: string | null = null;
  let lastPrompt: string | null = null;
  let lastReply: string | null = null;
  let when: string | null = null;

  for (const o of objs) {
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string') {
      title = o.aiTitle;
    }
    if (o.type === 'last-prompt' && typeof o.lastPrompt === 'string') {
      lastPrompt = o.lastPrompt;
    }
  }
  // The final assistant record is often a tool call with no prose, so walk back
  // until a non-empty text block turns up.
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type !== 'assistant') {
      continue;
    }
    const content = (o.message as { content?: unknown } | undefined)?.content;
    const text = textOf(content);
    if (text) {
      lastReply = text;
      when = typeof o.timestamp === 'string' ? o.timestamp : null;
      break;
    }
  }
  if (!title && !lastPrompt && !lastReply) {
    return null;
  }
  return { title, lastPrompt, lastReply, when, log };
}

// ------------------------------------------------------------------- codex --

/** The newest rollout whose session_meta names this conversation. */
export function findCodexLog(sessionId: string): string | null {
  const rows = listRollouts().filter((r) => r.sessionId === sessionId);
  if (!rows.length) {
    return null;
  }
  rows.sort((a, b) => b.modified - a.modified);
  return rows[0].file;
}

function codexPreview(sessionId: string): Preview | null {
  const log = findCodexLog(sessionId);
  if (!log) {
    return null;
  }
  const objs = tail(log);
  let title: string | null = codexThreadName(sessionId);
  let lastPrompt: string | null = null;
  let lastReply: string | null = null;
  let when: string | null = null;

  for (const o of objs) {
    const p = o.payload as Record<string, unknown> | undefined;
    if (!p) {
      continue;
    }
    if (o.type === 'event_msg' && p.type === 'task_complete' && typeof p.last_agent_message === 'string') {
      lastReply = p.last_agent_message;
      when = typeof o.timestamp === 'string' ? o.timestamp : when;
    }
    if (o.type === 'response_item' && p.type === 'message') {
      const text = textOf(p.content);
      if (p.role === 'user' && text) {
        lastPrompt = text;
      }
      if (p.role === 'assistant' && text && !lastReply) {
        lastReply = text;
        when = typeof o.timestamp === 'string' ? o.timestamp : when;
      }
    }
  }
  if (!title && !lastPrompt && !lastReply) {
    return null;
  }
  if (title === '') {
    title = null;
  }
  return { title, lastPrompt, lastReply, when, log };
}

/** Codex names each thread in session_index.jsonl rather than in the rollout. */
function codexThreadName(sessionId: string): string | null {
  const idx = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  let raw: string;
  try {
    raw = fs.readFileSync(idx, 'utf8');
  } catch {
    return null;
  }
  let name: string | null = null;
  for (const line of raw.split('\n')) {
    if (!line.includes(sessionId)) {
      continue;
    }
    try {
      const o = JSON.parse(line) as { id?: string; thread_name?: string };
      if (o.id === sessionId && o.thread_name) {
        name = o.thread_name;
      }
    } catch {
      /* a partially written line at the end of the file */
    }
  }
  return name;
}

// ------------------------------------------------------------------ shared --

interface Record_ {
  type?: string;
  timestamp?: string;
  [k: string]: unknown;
}

/**
 * The last `bytes` of a JSONL file, parsed. The first line is almost certainly
 * cut in half by the seek, so it is dropped.
 */
function tail(file: string, bytes = 512 * 1024): Record_[] {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const take = Math.min(bytes, size);
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(take);
    fs.readSync(fd, buf, 0, take, size - take);
    let lines = buf.toString('utf8').split('\n');
    if (take < size) {
      lines = lines.slice(1);
    }
    const out: Record_[] = [];
    for (const l of lines) {
      if (!l.trim()) {
        continue;
      }
      try {
        out.push(JSON.parse(l) as Record_);
      } catch {
        /* truncated or interleaved write */
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

/** Agent content blocks are arrays of typed parts; pull the prose out. */
function textOf(content: unknown): string | null {
  if (!content) {
    return null;
  }
  if (typeof content === 'string') {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const b of content) {
    if (typeof b === 'string') {
      parts.push(b);
    } else if (b && typeof b === 'object') {
      const t = (b as { text?: unknown; content?: unknown }).text;
      const c = (b as { text?: unknown; content?: unknown }).content;
      if (typeof t === 'string') {
        parts.push(t);
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
  }
  const joined = parts.join('\n').trim();
  return joined || null;
}

export function oneLine(s: string | null, max = 110): string {
  if (!s) {
    return '';
  }
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
