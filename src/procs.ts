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

/**
 * One CIM query for the whole table, then the tree is built in memory. Asking
 * per-pid would mean a PowerShell start-up per terminal, which is ~300 ms each.
 */
export async function listProcesses(maxAgeMs = 4000): Promise<Proc[]> {
  if (cache && Date.now() - cache.at < maxAgeMs) {
    return cache.procs;
  }
  const ps =
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
  const procs: Proc[] = rows
    .filter((r) => r && typeof r.ProcessId === 'number')
    .map((r) => ({
      pid: r.ProcessId as number,
      ppid: typeof r.ParentProcessId === 'number' ? (r.ParentProcessId as number) : 0,
      name: typeof r.Name === 'string' ? (r.Name as string) : '',
      commandLine: typeof r.CommandLine === 'string' ? (r.CommandLine as string) : '',
    }));
  cache = { at: Date.now(), procs };
  return procs;
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
