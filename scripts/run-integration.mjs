// Runs the integration tests and insists that some actually ran.
//
// `vscode-test` exits 0 when mocha finds no tests, which is how a broken
// glob or a spec written for the wrong runner passes CI while testing
// nothing. VS Code is also extremely noisy on stdout, so the log is kept
// back unless something goes wrong.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

// Run the runner's own entry point with this node, rather than going through
// npx: on Windows, spawning a .cmd without a shell is refused outright, and
// spawning one with a shell is its own hazard.
const require = createRequire(import.meta.url);
// The package does not export its manifest, so find it from a file it does.
const root = path.dirname(path.dirname(require.resolve('@vscode/test-cli')));
const manifest = path.join(root, 'package.json');
const bin = JSON.parse(readFileSync(manifest, 'utf8')).bin['vscode-test'];
const entry = path.join(root, bin);

const child = spawn(process.execPath, [entry], { stdio: ['ignore', 'pipe', 'pipe'] });

let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

child.on('close', (code) => {
  const passing = /(\d+) passing/.exec(log);
  const failing = /(\d+) failing/.exec(log);
  const passed = passing ? Number(passing[1]) : 0;
  const failed = failing ? Number(failing[1]) : 0;

  const ok = code === 0 && passed > 0 && failed === 0;
  if (!ok) {
    process.stdout.write(log);
  }
  for (const line of log.split('\n')) {
    if (/^\s+(✔|✓|\d+\))/.test(line) || /passing|failing/.test(line)) {
      process.stdout.write(line.trimEnd() + '\n');
    }
  }
  if (!passed) {
    process.stdout.write('\nNo integration tests ran. The glob or the runner is wrong.\n');
  }
  process.exit(ok ? 0 : code || 1);
});
