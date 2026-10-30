// The vscode:// link handler, read before an integration run and put back after.
//
// VS Code names itself the handler for vscode:// links every time it starts
// (on Windows: HKCU\Software\Classes\vscode\shell\open\command). The copy
// that @vscode/test-electron downloads for the integration tests does it too,
// so after a test run every vscode:// link on the machine -- the hub's
// hand-off links, the attention strip's focus links -- started that copy as a
// second VS Code, on the same user data, which then restored every window of
// the installed one (2026-10-30, three times). The run therefore remembers
// the handler before the test VS Code starts and writes it back afterwards.
// Elsewhere than Windows there is nothing to do: the handler lives in the
// app bundle (macOS) or a .desktop file (Linux), which a downloaded copy does
// not touch.

import { spawnSync } from 'node:child_process';
import process from 'node:process';

export const HANDLER_KEY = 'HKCU\\Software\\Classes\\vscode\\shell\\open\\command';

/**
 * The default value `reg query <key> /ve` printed, or null when there was
 * none. The value's name is printed in the system language -- `(Default)`,
 * `(預設)` -- so only the parentheses are relied on.
 */
export function parseRegQuery(output) {
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const m = /^\s*\([^)]*\)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i.exec(line);
    if (m) {
      return m[1].trim();
    }
  }
  return null;
}

/** Whether the handler must be put back: it was set before, and is something else now. */
export function handlerChanged(before, after) {
  return before !== null && before !== undefined && before !== after;
}

/** The handler command now, or null when there is none or this is not Windows. */
export function readHandler(key = HANDLER_KEY) {
  if (process.platform !== 'win32') {
    return null;
  }
  const r = spawnSync('reg.exe', ['query', key, '/ve'], { encoding: 'utf8' });
  if (r.status !== 0) {
    return null;
  }
  return parseRegQuery(r.stdout);
}

/** Write the handler command; true when the registry took it. */
export function writeHandler(command, key = HANDLER_KEY) {
  if (process.platform !== 'win32' || !command) {
    return false;
  }
  const r = spawnSync('reg.exe', ['add', key, '/ve', '/t', 'REG_SZ', '/d', command, '/f'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Remove a key, for the test that round-trips through a throwaway one. */
export function deleteKey(key) {
  if (process.platform !== 'win32') {
    return false;
  }
  return spawnSync('reg.exe', ['delete', key, '/f'], { encoding: 'utf8' }).status === 0;
}
