// Against the real operating system.
//
// The unit tests feed `ps` output to the parser from a fixture, which proves
// the parsing and nothing about the machine. These run the actual query, so
// they are the ones that answer "does this work on macOS" -- and in CI they
// answer it on all three platforms at once.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const OUT = path.join(__dirname, '..', 'out');
const { listProcesses, descendants } = require(OUT + '/procs.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The table is a moving target; a process may need a moment to appear in it. */
async function findPid(pid, tries = 10) {
  for (let i = 0; i < tries; i++) {
    const procs = await listProcesses(0);
    const row = procs.find((p) => p.pid === pid);
    if (row) {
      return { row, procs };
    }
    await sleep(300);
  }
  return { row: null, procs: [] };
}

test('listProcesses: reads this machine and finds this very process', async () => {
  const { row, procs } = await findPid(process.pid);
  assert.ok(procs.length > 5, 'the process table should not be nearly empty');
  assert.ok(row, 'our own pid must be in the table');
  assert.strictEqual(row.ppid, process.ppid, 'ppid must match what node reports');
  assert.match(row.name, /node/i, 'argv[0] of this process is node');
});

test('descendants: walks from the real parent down to this process', async () => {
  const { procs } = await findPid(process.pid);
  const kids = descendants(procs, process.ppid);
  assert.ok(kids.some((p) => p.pid === process.pid), 'we are a descendant of our parent');
});

// The reason -ww is passed to ps: BSD truncates the command line to the
// terminal width, and the uuid in `codex resume <uuid>` sits at the very end.
test('listProcesses: a long command line survives intact', async () => {
  const marker = 'windoallsmarker' + 'x'.repeat(300);
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 8000)', marker], {
    stdio: 'ignore',
  });
  try {
    const { row } = await findPid(child.pid);
    assert.ok(row, 'the child process must appear in the table');
    assert.ok(
      row.commandLine.includes(marker),
      'the whole command line must come back, not a width-truncated prefix',
    );
  } finally {
    child.kill();
  }
});

// On Windows the table arrives through PowerShell's stdout, in the console
// code page unless asked otherwise. In Big5 the second byte of 許, 功 or 蓋 is
// a backslash, so one Chinese command line used to make the JSON unparseable
// and the whole table empty -- for every terminal, not only that one.
test('listProcesses: a command line with non-ASCII text leaves the table intact', async () => {
  const marker = 'windoalls許功蓋請先完整閱讀交接摘要' + Date.now();
  const child = spawn(process.execPath, ['-e', 'setTimeout(function(){}, 8000)', marker], {
    stdio: 'ignore',
  });
  try {
    const { row, procs } = await findPid(child.pid);
    assert.ok(procs.length > 5, 'the table must survive the non-ASCII entry');
    assert.ok(row, 'the child process must appear in the table');
    assert.ok(row.commandLine.includes(marker), 'the text must come back as written, not transcoded');
  } finally {
    child.kill();
  }
});
