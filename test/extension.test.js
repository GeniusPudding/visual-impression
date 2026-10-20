// Tests for the parts of the extension that do not need a running VS Code:
// the matcher, the transcript reader and the on-disk index. Run with
//
//   npm test
//
// which compiles first, so these exercise out/*.js -- the files that actually
// ship -- rather than the TypeScript sources.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
const { descendants } = require(path.join(OUT, 'procs.js'));
const { pickCodexRollout, listRollouts, invalidateRolloutCache } = require(path.join(OUT, 'resolve.js'));
const { findCodexLog, getPreview, oneLine } = require(path.join(OUT, 'preview.js'));
const store = require(path.join(OUT, 'store.js'));

// ---------------------------------------------------------------- fixtures --

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'windoalls-ext-'));
  return dir;
}

function withHome(dir, fn) {
  const real = process.env.USERPROFILE;
  const realHome = process.env.HOME;
  process.env.USERPROFILE = dir;
  process.env.HOME = dir;
  try {
    return fn();
  } finally {
    process.env.USERPROFILE = real;
    process.env.HOME = realHome;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Writes a rollout. `named` is the uuid in the FILE NAME and `sessionId` the
 * one inside session_meta; they differ for every segment after a resume.
 *
 * `pad` inflates session_meta past any fixed read buffer, because real ones
 * run to ~20 KB and a fixed buffer silently discards every file.
 */
function writeRollout(home, { named, sessionId, cwd, source = 'vscode', started, modified, pad = 0, prompt = 'hello', reply = 'done' }) {
  const d = new Date(started);
  const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()),
    String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${named}.jsonl`);
  const meta = {
    timestamp: new Date(started).toISOString(),
    type: 'session_meta',
    payload: {
      id: named, session_id: sessionId, cwd, source,
      originator: 'codex-tui', timestamp: new Date(started).toISOString(),
      filler: 'x'.repeat(pad),
    },
  };
  const lines = [
    JSON.stringify(meta),
    JSON.stringify({ timestamp: new Date(started).toISOString(), type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } }),
    JSON.stringify({ timestamp: new Date(started).toISOString(), type: 'event_msg',
      payload: { type: 'task_complete', last_agent_message: reply } }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  fs.utimesSync(file, new Date(modified ?? started), new Date(modified ?? started));
  return file;
}

const CONV = '01a11bd7-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SEG2 = 'ffffffff-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER = '01a15313-cccc-4ccc-8ccc-cccccccccccc';

function rollout(sessionId, cwd, source, modified) {
  return { file: `${sessionId}.jsonl`, sessionId, cwd, source, started: modified, modified };
}

// ----------------------------------------------------------------- matcher --

test('pickCodexRollout: matches a vscode session in this workspace', () => {
  const rows = [rollout(CONV, 'C:\\work\\repo', 'vscode', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), CONV);
});

test('pickCodexRollout: is case- and trailing-slash-insensitive', () => {
  const rows = [rollout(CONV, 'C:\\Work\\Repo\\', 'vscode', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'c:\\work\\repo'), CONV);
});

test('pickCodexRollout: ignores another workspace', () => {
  const rows = [rollout(CONV, 'C:\\work\\other', 'vscode', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), null);
});

test('pickCodexRollout: ignores a terminal-tab session, which is not ours', () => {
  // The inverse of the rule in wt-snapshot-scan.ps1. A rollout without
  // source=vscode belongs to a Windows Terminal tab, and that tool claims it.
  const rows = [rollout(CONV, 'C:\\work\\repo', 'cli', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), null);
});

test('pickCodexRollout: ignores a subagent, whose source is an object', () => {
  const rows = [rollout(CONV, 'C:\\work\\repo', '', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), null);
});

test('pickCodexRollout: skips a session another terminal already claimed', () => {
  const rows = [
    rollout(CONV, 'C:\\work\\repo', 'vscode', 200),
    rollout(OTHER, 'C:\\work\\repo', 'vscode', 100),
  ];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo', new Set([CONV])), OTHER);
});

test('pickCodexRollout: prefers the most recently written', () => {
  const rows = [
    rollout(CONV, 'C:\\work\\repo', 'vscode', 100),
    rollout(OTHER, 'C:\\work\\repo', 'vscode', 900),
  ];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), OTHER);
});

test('pickCodexRollout: returns null rather than guessing with no cwd', () => {
  const rows = [rollout(CONV, 'C:\\work\\repo', 'vscode', 100)];
  assert.strictEqual(pickCodexRollout(rows, ''), null);
});

// ------------------------------------------------------- reading rollouts --

test('listRollouts: parses a session_meta far longer than any read buffer', () => {
  // The real bug: session_meta carries the whole environment context and runs
  // to ~20 KB, so a fixed 8 KB buffer finds no newline and discards the file.
  const home = tempHome();
  withHome(home, () => {
    writeRollout(home, { named: CONV, sessionId: CONV, cwd: 'C:\\work\\repo', started: Date.now(), pad: 120_000 });
    invalidateRolloutCache();
    const rows = listRollouts(0);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].sessionId, CONV);
  });
});

test('listRollouts: skips a file that is not a rollout', () => {
  const home = tempHome();
  withHome(home, () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'rollout-broken.jsonl'), 'not json\n', 'utf8');
    invalidateRolloutCache();
    assert.strictEqual(listRollouts(0).length, 0);
  });
});

test('findCodexLog: a conversation spans several files, named after themselves', () => {
  // The second field bug: matching on the file name only ever finds the first
  // segment, so every `codex resume` since is invisible.
  const home = tempHome();
  withHome(home, () => {
    const t0 = Date.now() - 3 * 3600_000;
    writeRollout(home, { named: CONV, sessionId: CONV, cwd: 'C:\\work\\repo', started: t0, modified: t0 });
    const second = writeRollout(home, {
      named: SEG2, sessionId: CONV, cwd: 'C:\\work\\repo',
      started: t0 + 3600_000, modified: Date.now(), prompt: 'the newest thing I asked',
    });
    invalidateRolloutCache();
    assert.strictEqual(findCodexLog(CONV), second);
    assert.strictEqual(findCodexLog(SEG2), null, 'SEG2 names a file but is nobody\'s session id');
  });
});

test('getPreview: reads prompt and reply out of the newest segment', () => {
  const home = tempHome();
  withHome(home, () => {
    const t0 = Date.now() - 3600_000;
    writeRollout(home, { named: CONV, sessionId: CONV, cwd: 'C:\\work\\repo', started: t0, modified: t0, prompt: 'old', reply: 'old reply' });
    writeRollout(home, {
      named: SEG2, sessionId: CONV, cwd: 'C:\\work\\repo', started: t0 + 1000, modified: Date.now(),
      prompt: 'the newest thing I asked', reply: 'and the newest answer',
    });
    invalidateRolloutCache();
    const p = getPreview('codex', CONV, 'C:\\work\\repo');
    assert.ok(p, 'expected a preview');
    assert.strictEqual(p.lastPrompt, 'the newest thing I asked');
    assert.strictEqual(p.lastReply, 'and the newest answer');
  });
});

test('getPreview: nothing for an unknown session or a plain shell', () => {
  const home = tempHome();
  withHome(home, () => {
    invalidateRolloutCache();
    assert.strictEqual(getPreview('codex', 'deadbeef-0000-4000-8000-000000000000', ''), null);
    assert.strictEqual(getPreview('shell', CONV, ''), null);
    assert.strictEqual(getPreview('codex', '', ''), null);
  });
});

// ------------------------------------------------------------ process tree --

test('descendants: walks children, grandchildren and no further than asked', () => {
  const procs = [
    { pid: 2, ppid: 1, name: 'pwsh.exe', commandLine: '' },
    { pid: 3, ppid: 2, name: 'node.exe', commandLine: 'codex' },
    { pid: 4, ppid: 3, name: 'child.exe', commandLine: '' },
    { pid: 9, ppid: 99, name: 'elsewhere.exe', commandLine: '' },
  ];
  const got = descendants(procs, 1).map((p) => p.pid).sort();
  assert.deepStrictEqual(got, [2, 3, 4]);
});

test('descendants: survives a parent/child cycle', () => {
  const procs = [
    { pid: 2, ppid: 1, name: 'a', commandLine: '' },
    { pid: 3, ppid: 2, name: 'b', commandLine: '' },
    { pid: 2, ppid: 3, name: 'a-again', commandLine: '' },
  ];
  const got = descendants(procs, 1).map((p) => p.pid);
  assert.ok(got.length < 10, 'must terminate');
});

// ------------------------------------------------------------------ index --

test('store: slug lines up with how Claude encodes a project path', () => {
  assert.strictEqual(store.slugFor('C:\\work\\repo'), 'C--work-repo');
});

test('store: round-trips an index', () => {
  const home = tempHome();
  withHome(home, () => {
    const ix = store.readIndex('C:\\work\\repo');
    assert.deepStrictEqual(ix.terminals, []);
    ix.terminals.push({
      key: '1:pwsh', name: 'codex', cwd: 'C:\\work\\repo', shellPid: 1,
      app: 'codex', session: CONV, title: 'A thread',
      openedAt: new Date().toISOString(), lastSeen: new Date().toISOString(), closedAt: null,
    });
    store.writeIndex(ix);
    const back = store.readIndex('C:\\work\\repo');
    assert.strictEqual(back.terminals.length, 1);
    assert.strictEqual(back.terminals[0].session, CONV);
  });
});

test('store: an unreadable index reads as empty rather than throwing', () => {
  const home = tempHome();
  withHome(home, () => {
    fs.mkdirSync(store.stateDir(), { recursive: true });
    fs.writeFileSync(store.indexPath('C:\\work\\repo'), '{ not json', 'utf8');
    assert.deepStrictEqual(store.readIndex('C:\\work\\repo').terminals, []);
  });
});

test('store: prunes closed terminals past the window but never open ones', () => {
  const old = new Date(Date.now() - 30 * 86400_000).toISOString();
  const ix = {
    version: 1, folder: 'C:\\work\\repo', updatedAt: '',
    terminals: [
      { key: 'a', closedAt: old },
      { key: 'b', closedAt: new Date().toISOString() },
      { key: 'c', closedAt: null },
    ],
  };
  store.pruneHistory(ix, 14);
  assert.deepStrictEqual(ix.terminals.map((t) => t.key), ['b', 'c']);
});

test('restorable: offers closed records, newest first', () => {
  const ix = { version: 1, folder: 'C:\work\repo', updatedAt: '', terminals: [
    { key: 'a', app: 'claude', closedAt: '2026-10-20T08:00:00.000Z' },
    { key: 'b', app: 'codex',  closedAt: '2026-10-20T09:00:00.000Z' },
    { key: 'c', app: 'claude', closedAt: null },
  ] };
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['b', 'a']);
});

// A window reload reconnects terminals under their original pids: activation
// marks every record closed, then the scan finds them live again. Offering one
// back would start a second agent on a conversation already running.
test('REGRESSION -- restorable: never offers a terminal that is on screen', () => {
  const ix = { version: 1, folder: 'C:\work\repo', updatedAt: '', terminals: [
    { key: '5320:pwsh', app: 'claude', closedAt: '2026-10-20T08:00:00.000Z' },
    { key: '4100:pwsh', app: 'claude', closedAt: '2026-10-20T08:00:00.000Z' },
  ] };
  const open = new Set(['5320:pwsh']);
  assert.deepStrictEqual(store.restorable(ix, open).map((t) => t.key), ['4100:pwsh']);
  assert.deepStrictEqual(store.restorable(ix, new Set(['5320:pwsh', '4100:pwsh'])), []);
});

test('planRestore: uses every revived terminal before opening a new one', () => {
  assert.deepStrictEqual(store.planRestore(3, 2), [true, true, false]);
  assert.deepStrictEqual(store.planRestore(2, 5), [true, true]);
  assert.deepStrictEqual(store.planRestore(2, 0), [false, false]);
  assert.deepStrictEqual(store.planRestore(0, 3), []);
});

// ----------------------------------------------------------------- format --

test('oneLine: flattens and truncates', () => {
  assert.strictEqual(oneLine('a\n  b\tc'), 'a b c');
  assert.strictEqual(oneLine('x'.repeat(50), 10).length, 10);
  assert.strictEqual(oneLine(null), '');
});
