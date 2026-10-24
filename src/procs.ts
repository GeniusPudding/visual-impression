// Which process is running inside a terminal?
//
// VS Code hands out a terminal's shell pid and nothing else, so the agent has
// to be found by walking down from it. All terminals in a window share one
// ptyHost, which is why this cannot be done from outside VS Code at all -- but
// from inside, the shell pid is unambiguous and the walk is short.

import { execFile } from 'child_process';

export interface Proc {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
}

let cache: { at: number; procs: Proc[] } | null = null;

const WINDOWS = process.platform === 'win32';

/**
 * One query for the whole table, then the tree is built in memory. Asking
 * per-pid would mean a process start-up per terminal.
 */
export async function listProcesses(maxAgeMs = 4000): Promise<Proc[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) {
    return cache.procs;
  }
  const procs = WINDOWS ? await listWindows() : await listPosix();
  cache = { at: Date.now(), procs };
  return procs;
}

/**
 * `ps` on macOS and Linux. Cheap -- a few milliseconds -- where the Windows
 * side costs over a second, and that second is the PowerShell interpreter
 * starting, not the query.
 */
async function listPosix(): Promise<Proc[]> {
  // -ww because BSD ps truncates the command line to the terminal width, and
  // the end of that line is exactly what is being read: `codex resume <uuid>`.
  let out = await run('ps', ['-ax', '-ww', '-o', 'pid=,ppid=,args=']);
  if (!out.trim()) {
    // Not every ps accepts a repeated -w. A truncated command line still
    // identifies the agent; only the uuid at the end may be lost.
    out = await run('ps', ['-ax', '-o', 'pid=,ppid=,args=']);
  }
  return parsePs(out);
}

/**
 * Three columns: pid, ppid, and the command line, which holds the spaces.
 *
 * `comm` is deliberately not asked for. On macOS it is the executable's full
 * path, and those contain spaces -- /Applications/Visual Studio
 * Code.app/Contents/MacOS/Electron -- so a four-column split cannot be
 * unambiguously parsed. The name is taken from argv[0] instead.
 */
export function parsePs(stdout: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const commandLine = m[3].trim();
    if (!commandLine) {
      continue; // a kernel thread has no argv
    }
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      name: argv0Name(commandLine),
      commandLine,
    });
  }
  return procs;
}

function argv0Name(commandLine: string): string {
  const argv0 = commandLine.split(' ')[0];
  const cut = Math.max(argv0.lastIndexOf('/'), argv0.lastIndexOf('\\'));
  return cut >= 0 ? argv0.slice(cut + 1) : argv0;
}

async function listWindows(): Promise<Proc[]> {
  // PowerShell writes stdout in the console code page. On a Big5 (CP950)
  // system a Chinese command line -- `claude "請先讀…"` -- comes out as bytes
  // whose trailing byte can be 0x5C, a backslash, which turns the JSON into
  // an invalid escape and the whole table into nothing. Ask for UTF-8.
  const ps =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'Get-CimInstance Win32_Process | ' +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ' +
    'ConvertTo-Json -Compress -Depth 2';
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let rows: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(out) as unknown;
    rows = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
  } catch {
    rows = [];
  }
  return rows
    .filter((r) => r && typeof r.ProcessId === 'number')
    .map((r) => ({
      pid: r.ProcessId as number,
      ppid: typeof r.ParentProcessId === 'number' ? (r.ParentProcessId as number) : 0,
      name: typeof r.Name === 'string' ? (r.Name as string) : '',
      commandLine: typeof r.CommandLine === 'string' ? (r.CommandLine as string) : '',
    }));
}

export function invalidateProcessCache(): void {
  cache = null;
}

/** Every descendant of `root`, nearest first. */
export function descendants(procs: Proc[], root: number): Proc[] {
  const byParent = new Map<number, Proc[]>();
  for (const p of procs) {
    const list = byParent.get(p.ppid);
    if (list) {
      list.push(p);
    } else {
      byParent.set(p.ppid, [p]);
    }
  }
  const out: Proc[] = [];
  const seen = new Set<number>([root]);
  let frontier = byParent.get(root) ?? [];
  // Depth-bounded: a runaway parent/child cycle in the table must not hang the
  // extension host.
  for (let depth = 0; depth < 12 && frontier.length; depth++) {
    const next: Proc[] = [];
    for (const p of frontier) {
      if (seen.has(p.pid)) {
        continue;
      }
      seen.add(p.pid);
      out.push(p);
      next.push(...(byParent.get(p.pid) ?? []));
    }
    frontier = next;
  }
  return out;
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}
