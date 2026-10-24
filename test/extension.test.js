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
const { descendants, parsePs } = require(path.join(OUT, 'procs.js'));
const { pickCodexRollout, listRollouts, invalidateRolloutCache, normalisePath } = require(path.join(OUT, 'resolve.js'));
const { findCodexLog, getPreview, oneLine } = require(path.join(OUT, 'preview.js'));
const store = require(path.join(OUT, 'store.js'));
const { probeGroups, autoReadVerdict, LAYOUT_STALE_MS } = require(path.join(OUT, 'layout.js'));

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

test('pickCodexRollout: ignores a trailing slash', () => {
  const rows = [rollout(CONV, 'C:\\work\\repo\\', 'vscode', 100)];
  assert.strictEqual(pickCodexRollout(rows, 'C:\\work\\repo'), CONV);
});

// Case is not a cosmetic difference everywhere. On Windows these are one
// directory and the session belongs to this terminal; on Linux they are two,
// and claiming the rollout would drop the wrong conversation into the tab.
test('pickCodexRollout: folds case only where the filesystem does', () => {
  const rows = [rollout(CONV, 'C:\\Work\\Repo', 'vscode', 100)];
  const got = pickCodexRollout(rows, 'c:\\work\\repo');
  if (process.platform === 'win32') {
    assert.strictEqual(got, CONV);
  } else {
    assert.strictEqual(got, null, 'two paths differing only by case are two directories here');
  }
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

// The index used to live beside the Windows terminal tool this grew out of.
// A published extension cannot leave a ~/.wt-tabs directory on a stranger's
// machine, so it moved -- and has to bring an existing history with it.
test('store: an index from the old location is moved, once', () => {
  const home = tempHome();
  withHome(home, () => {
    const folder = '/w/repo';
    const old = path.join(store.legacyStateDir(), store.slugFor(folder) + '.json');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, JSON.stringify({ version: 1, folder, terminals: [{ key: 'kept' }] }));

    assert.strictEqual(store.migrateLegacyIndex(folder), old);
    assert.strictEqual(fs.existsSync(old), false, 'the old copy must not be left to go stale');
    assert.deepStrictEqual(store.readIndex(folder).terminals.map((t) => t.key), ['kept']);
    assert.strictEqual(store.migrateLegacyIndex(folder), null, 'nothing left to move');
  });
});

test('store: migrating never overwrites an index already in the new place', () => {
  const home = tempHome();
  withHome(home, () => {
    const folder = '/w/repo';
    const old = path.join(store.legacyStateDir(), store.slugFor(folder) + '.json');
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, JSON.stringify({ version: 1, folder, terminals: [{ key: 'stale' }] }));
    fs.mkdirSync(store.stateDir(), { recursive: true });
    fs.writeFileSync(store.indexPath(folder), JSON.stringify({ version: 1, folder, terminals: [{ key: 'current' }] }));

    assert.strictEqual(store.migrateLegacyIndex(folder), null);
    assert.deepStrictEqual(store.readIndex(folder).terminals.map((t) => t.key), ['current']);
  });
});

test('store: the state directory can be moved, and ~ means home', () => {
  const home = tempHome();
  withHome(home, () => {
    try {
      store.setStateDir('~/elsewhere');
      assert.strictEqual(store.stateDir(), path.join(home, 'elsewhere'));
      store.setStateDir(path.join(home, 'absolute'));
      assert.strictEqual(store.stateDir(), path.join(home, 'absolute'));
      store.setStateDir('   ');
      assert.strictEqual(store.stateDir(), path.join(home, '.visual-impression'));
    } finally {
      store.setStateDir('');
    }
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

const rec = (over) => Object.assign({
  key: 'k', name: 'bash', cwd: '/w', shellPid: 1, app: 'claude', session: null,
  title: null, openedAt: '', lastSeen: '', closedAt: null,
  lastCommand: null, lastCommandAt: null,
}, over);
const ixOf = (...terminals) => ({ version: 1, folder: '/w', updatedAt: '', terminals });

test('restorable: offers closed records, newest first', () => {
  const ix = ixOf(
    rec({ key: 'a', session: 'sa', closedAt: '2026-10-20T08:00:00.000Z' }),
    rec({ key: 'b', session: 'sb', closedAt: '2026-10-20T09:00:00.000Z' }),
    rec({ key: 'c', session: 'sc', closedAt: null }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['b', 'a']);
});

// A window reload reconnects terminals under their original pids: activation
// marks every record closed, then the scan finds them live again. Offering one
// back would start a second agent on a conversation already running.
test('REGRESSION -- restorable: never offers a terminal that is on screen', () => {
  const ix = { version: 1, folder: 'C:\\work\\repo', updatedAt: '', terminals: [
    { key: '5320:pwsh', app: 'claude', closedAt: '2026-10-20T08:00:00.000Z' },
    { key: '4100:pwsh', app: 'claude', closedAt: '2026-10-20T08:00:00.000Z' },
  ] };
  const open = new Set(['5320:pwsh']);
  assert.deepStrictEqual(store.restorable(ix, open).map((t) => t.key), ['4100:pwsh']);
  assert.deepStrictEqual(store.restorable(ix, new Set(['5320:pwsh', '4100:pwsh'])), []);
});

const REUSE = { kind: 'reuse' };
const TAB = { kind: 'tab' };
const splitOf = (parent) => ({ kind: 'split', parent });

/** planByLayout over n terminals with nothing remembered about them. */
const plain = (n, spares, perTab) =>
  store.planByLayout(
    Array.from({ length: n }, (_, i) => 'k' + i),
    [],
    spares,
    perTab,
  );

test('planByLayout: uses every revived terminal before opening a new one', () => {
  assert.deepStrictEqual(plain(3, 3).plan, [REUSE, REUSE, REUSE]);
  assert.deepStrictEqual(plain(2, 5).plan, [REUSE, REUSE]);
  assert.deepStrictEqual(plain(0, 3).plan, []);
});

// Opening a tab per terminal is what turned a four-pane project into four
// tabs showing one terminal each. New terminals go side by side instead.
test('planByLayout: splits the new terminals into one tab', () => {
  assert.deepStrictEqual(plain(3, 0).plan, [TAB, splitOf(0), splitOf(1)]);
  // A reused terminal is already in a pane, so it is never a parent: splitting
  // off it would rearrange the layout VS Code just rebuilt.
  assert.deepStrictEqual(plain(3, 1).plan, [REUSE, TAB, splitOf(1)]);
  // ...and it does not eat a slot in the tab the others are cut into.
  assert.deepStrictEqual(plain(5, 1, 2).plan, [REUSE, TAB, splitOf(1), TAB, splitOf(3)]);
});

// VS Code inserts a split immediately after its parent, so hanging every pane
// off the tab's first terminal builds the row backwards: 1, 2, 3 arrives as
// 1, 3, 2. Each pane names the one before it instead.
test('REGRESSION -- planByLayout: panes come out in the order given', () => {
  const { plan } = plain(4, 0, 4);
  assert.deepStrictEqual(plan, [TAB, splitOf(0), splitOf(1), splitOf(2)]);
  // Replay what VS Code does with that plan: splice each pane in after its
  // parent, and the row must read 0, 1, 2, 3.
  const row = [];
  plan.forEach((p, i) => {
    if (p.kind === 'split') {
      row.splice(row.indexOf(p.parent) + 1, 0, i);
    } else {
      row.push(i);
    }
  });
  assert.deepStrictEqual(row, [0, 1, 2, 3]);
});

test('planByLayout: starts another tab once a group is full', () => {
  assert.deepStrictEqual(plain(5, 0, 2).plan, [TAB, splitOf(0), TAB, splitOf(2), TAB]);
});

test('planByLayout: a list gives each tab its own number of panes', () => {
  assert.deepStrictEqual(plain(6, 0, [2, 1, 3]).plan, [
    TAB, splitOf(0), TAB, TAB, splitOf(3), splitOf(4),
  ]);
  // The last entry repeats rather than falling back to one per tab.
  assert.deepStrictEqual(plain(5, 0, [1, 2]).plan, [TAB, TAB, splitOf(1), TAB, splitOf(3)]);
});

test('planByLayout: one per tab is still available', () => {
  assert.deepStrictEqual(plain(3, 0, 1).plan, [TAB, TAB, TAB]);
  // Nonsense sizes must not produce a terminal with no parent.
  for (const bad of [0, -5, NaN, [], [0], ['x']]) {
    assert.deepStrictEqual(plain(2, 0, bad).plan, [TAB, TAB], String(bad));
  }
});

// The point of reading the arrangement: the picker lists conversations
// newest-closed first, the screen had them two in one tab and one beside.
test('planByLayout: a remembered arrangement decides the tabs and the order', () => {
  const { order, plan } = store.planByLayout(
    ['c', 'a', 'b'],
    [['a', 'b'], ['c']],
    0,
  );
  assert.deepStrictEqual(order, [1, 2, 0]);
  assert.deepStrictEqual(plan, [TAB, splitOf(0), TAB]);
});

test('planByLayout: what the arrangement does not mention follows at the end', () => {
  const { order, plan } = store.planByLayout(
    ['old1', 'a', 'b', 'old2'],
    [['a'], ['b']],
    0,
    2,
  );
  assert.deepStrictEqual(order, [1, 2, 0, 3]);
  assert.deepStrictEqual(plan, [TAB, TAB, TAB, splitOf(2)]);
});

test('planByLayout: a remembered terminal that is not being restored is skipped', () => {
  const { order, plan } = store.planByLayout(['a', 'c'], [['a', 'b', 'c']], 0);
  assert.deepStrictEqual(order, [0, 1]);
  assert.deepStrictEqual(plan, [TAB, splitOf(0)]);
});

// --------------------------------------------------------- layout probe ----

/** A window whose panes are arranged like `groups`, driven by the probe. */
function fakeWindow(groups, opts = {}) {
  const ids = groups.flat();
  const order = opts.listed ?? ids;
  let active;
  return {
    ids: order,
    steps: 0,
    async activate(id) {
      active = opts.deaf ? undefined : id;
    },
    async next() {
      this.steps++;
      const g = groups.find((x) => x.includes(active));
      if (!g) {
        return;
      }
      active = g[(g.indexOf(active) + 1) % g.length];
    },
    active: () => active,
  };
}

test('probeGroups: reads which terminals share a tab', async () => {
  const groups = [['a', 'b'], ['c'], ['d', 'e', 'f']];
  assert.deepStrictEqual(await probeGroups(fakeWindow(groups)), groups);
});

// focusNextPane wraps, so a tab is read as a cycle starting from whichever
// of its panes was created first. Membership is exact; the order is only the
// true one when the panes were split in the order they were created.
test('probeGroups: a tab reads as a cycle from its earliest pane', async () => {
  const win = fakeWindow([['a', 'b', 'c']], { listed: ['b', 'c', 'a'] });
  assert.deepStrictEqual(await probeGroups(win), [['b', 'c', 'a']]);
});

test('probeGroups: every terminal is accounted for exactly once', async () => {
  const groups = [['a', 'b', 'c'], ['d'], ['e', 'f']];
  const seen = (await probeGroups(fakeWindow(groups))).flat();
  assert.deepStrictEqual(seen.slice().sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.strictEqual(new Set(seen).size, seen.length);
});

// If focus cannot be driven -- the window lost it mid-walk -- the reading
// must still terminate, and say the least wrong thing: one pane per tab.
test('probeGroups: a window that will not take focus still returns', async () => {
  const win = fakeWindow([['a', 'b'], ['c']], { deaf: true });
  assert.deepStrictEqual(await probeGroups(win), [['a'], ['b'], ['c']]);
  assert.strictEqual(win.steps, 0);
});

// The automatic pass must give way the moment the window is in use again:
// no further focus move, and no half-reading written down as if it were one.
test('REGRESSION -- probeGroups: interrupted before it starts, it moves nothing', async () => {
  const win = fakeWindow([['a', 'b'], ['c']]);
  win.interrupted = () => true;
  assert.strictEqual(await probeGroups(win), null);
  assert.strictEqual(win.steps, 0);
});

test('REGRESSION -- probeGroups: interrupted mid-walk, it stops at the next step', async () => {
  const win = fakeWindow([['a', 'b', 'c'], ['d']]);
  win.interrupted = () => win.steps >= 1;
  assert.strictEqual(await probeGroups(win), null, 'a partial reading is no reading');
  assert.strictEqual(win.steps, 1, 'one step was already under way; none after');
});

test('probeGroups: a probe without an interrupted() still reads as before', async () => {
  const groups = [['a', 'b'], ['c']];
  const win = fakeWindow(groups);
  delete win.interrupted;
  assert.deepStrictEqual(await probeGroups(win), groups);
});

// ---------------------------------------------------- automatic reading ----

/** The automatic pass at a moment where everything says "read". */
function readable(over = {}) {
  return {
    mode: 'onBlur',
    focused: false,
    unfocusedForMs: 30_000,
    graceMs: 20_000,
    terminals: 3,
    hasActiveTerminal: true,
    unchanged: false,
    lastReadAgeMs: 0,
    ...over,
  };
}

test('autoReadVerdict: only onBlur ever reads by itself', () => {
  assert.strictEqual(autoReadVerdict(readable()), 'read');
  assert.strictEqual(autoReadVerdict(readable({ mode: 'manual' })), 'manual');
  assert.strictEqual(autoReadVerdict(readable({ mode: 'off' })), 'off');
  assert.strictEqual(autoReadVerdict(readable({ mode: 'something-new' })), 'manual', 'an unknown mode does not move focus');
});

test('REGRESSION -- autoReadVerdict: a window in use is never walked', () => {
  assert.strictEqual(autoReadVerdict(readable({ focused: true })), 'focused');
});

test('autoReadVerdict: a glance at another window is not a departure', () => {
  assert.strictEqual(autoReadVerdict(readable({ unfocusedForMs: 1_000 })), 'too-soon');
  assert.strictEqual(autoReadVerdict(readable({ unfocusedForMs: 20_000 })), 'read', 'the grace period, exactly, is enough');
});

test('autoReadVerdict: nothing to read, or nothing to hand focus back to', () => {
  assert.strictEqual(autoReadVerdict(readable({ terminals: 1 })), 'too-few');
  assert.strictEqual(autoReadVerdict(readable({ hasActiveTerminal: false })), 'no-active-terminal');
});

test('autoReadVerdict: the same terminals are not re-read until the reading is stale', () => {
  assert.strictEqual(autoReadVerdict(readable({ unchanged: true, lastReadAgeMs: 60_000 })), 'fresh');
  assert.strictEqual(autoReadVerdict(readable({ unchanged: true, lastReadAgeMs: LAYOUT_STALE_MS })), 'read');
  assert.strictEqual(autoReadVerdict(readable({ unchanged: false, lastReadAgeMs: 0 })), 'read', 'a new terminal is worth a fresh reading');
});

// ------------------------------------------------- layout without a walk ----
// TAB, REUSE and splitOf are the placements declared for planByLayout above.

test('layoutOfPlan: the splits a restore opened share a tab, by their new keys', () => {
  const plan = [TAB, splitOf(0), splitOf(1), TAB, splitOf(3)];
  assert.deepStrictEqual(store.layoutOfPlan(['a', 'b', 'c', 'd', 'e'], plan), [
    ['a', 'b', 'c'],
    ['d', 'e'],
  ]);
});

test('layoutOfPlan: reused terminals are in a tab VS Code owns, so they are left out', () => {
  const plan = [REUSE, REUSE, TAB, splitOf(2)];
  assert.deepStrictEqual(store.layoutOfPlan(['r1', 'r2', 'a', 'b'], plan), [['a', 'b']]);
});

test('layoutOfPlan: a terminal that never reported a pid is skipped, its splits still grouped', () => {
  const plan = [TAB, splitOf(0), splitOf(1)];
  assert.deepStrictEqual(store.layoutOfPlan([undefined, 'b', 'c'], plan), [['b', 'c']]);
  assert.deepStrictEqual(store.layoutOfPlan([undefined, undefined], [TAB, splitOf(0)]), [], 'nothing known, nothing written');
});

test('mergeLayout: the fresh tabs come first and the old ones are trimmed to live records', () => {
  const known = new Set(['a', 'b', 'old1', 'old3']);
  const merged = store.mergeLayout([['a', 'b']], [['old1', 'old2'], ['gone'], ['old3', 'a']], known);
  assert.deepStrictEqual(merged, [['a', 'b'], ['old1'], ['old3']]);
});

test('mergeLayout: with nothing old it is just the fresh reading', () => {
  assert.deepStrictEqual(store.mergeLayout([['a'], ['b', 'c']], [], new Set()), [['a'], ['b', 'c']]);
});

test('isWorthRecording: keeps real work, drops navigation and noise', () => {
  assert.ok(store.isWorthRecording('npm run dev'));
  assert.ok(store.isWorthRecording('python train.py --epochs 40'));
  assert.ok(store.isWorthRecording('  pytest -k auth  '));
  for (const noise of ['', '   ', 'cd ../other', 'ls -la', 'pwd', 'clear', 'exit', 'LOGOUT']) {
    assert.strictEqual(store.isWorthRecording(noise), false, noise);
  }
  assert.strictEqual(store.isWorthRecording('x'.repeat(2001)), false);
});

// The restore types these in itself. Recording them would make a restored
// terminal remember nothing but the restore.
test('isWorthRecording: ignores the resume commands this extension sends', () => {
  assert.strictEqual(store.isWorthRecording('claude --resume abc-123'), false);
  assert.strictEqual(store.isWorthRecording('claude -c'), false);
  assert.strictEqual(store.isWorthRecording('codex resume abc-123'), false);
  assert.ok(store.isWorthRecording('codex exec "fix the build"'));
});

// A record is keyed by pid, so reopening the window writes the same
// conversation again under a new key. Six rows for one conversation and three
// empty shells is what that looked like before this.
test('REGRESSION -- restorable: one row per conversation, newest kept', () => {
  const ix = ixOf(
    rec({ key: 'old', session: 'same', closedAt: '2026-10-20T08:00:00.000Z' }),
    rec({ key: 'new', session: 'same', closedAt: '2026-10-20T09:00:00.000Z' }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['new']);
});

test('REGRESSION -- restorable: never offers a conversation that is running', () => {
  const ix = ixOf(
    rec({ key: 'closed', session: 'same', closedAt: '2026-10-20T08:00:00.000Z' }),
    rec({ key: 'live', session: 'same', closedAt: null }),
  );
  assert.deepStrictEqual(store.restorable(ix), []);
});

// Closing a window stamps each terminal as its own event, milliseconds apart
// in whatever order the shells exit. Sorting on that shuffled the panes; the
// four closures are one event, and inside it the recorded order is the order
// they were on screen.
test('REGRESSION -- restorable: one window close keeps its on-screen order', () => {
  const ix = ixOf(
    rec({ key: 'left', session: 's1', closedAt: '2026-10-20T15:33:10.604Z' }),
    rec({ key: 'middle', session: 's2', closedAt: '2026-10-20T15:33:10.652Z' }),
    rec({ key: 'right', session: 's3', closedAt: '2026-10-20T15:33:10.637Z' }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['left', 'middle', 'right']);
});

// But a terminal closed on its own, an hour before the window went, is a
// separate event -- and the newest event is still the one to offer first.
test('restorable: a separate, newer closure comes first', () => {
  const ix = ixOf(
    rec({ key: 'early', session: 's1', closedAt: '2026-10-20T14:00:00.000Z' }),
    rec({ key: 'a', session: 's2', closedAt: '2026-10-20T15:33:10.604Z' }),
    rec({ key: 'b', session: 's3', closedAt: '2026-10-20T15:33:10.500Z' }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['a', 'b', 'early']);
});

test('restorable: a shell that ran nothing is not worth offering', () => {
  const ix = ixOf(
    rec({ key: 'empty', app: 'shell', closedAt: '2026-10-20T08:00:00.000Z' }),
    rec({ key: 'ran', app: 'shell', lastCommand: 'npm run dev', closedAt: '2026-10-20T08:00:00.000Z' }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['ran']);
});

// Two different conversations are two rows, however alike they look.
test('restorable: keeps distinct sessions apart', () => {
  const ix = ixOf(
    rec({ key: 'a', session: 'one', closedAt: '2026-10-20T08:00:00.000Z' }),
    rec({ key: 'b', session: 'two', closedAt: '2026-10-20T09:00:00.000Z' }),
  );
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.key), ['b', 'a']);
});

// ------------------------------------------------------------------ posix --

test('parsePs: reads pid, ppid and the whole command line', () => {
  const out = [
    '  1     0 /sbin/launchd',
    '  842   1 -zsh',
    ' 1337 842 node /Users/me/.nvm/versions/node/v20.11.0/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    ' 1400 842 codex resume 01a11bd7-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '',
  ].join('\n');
  const procs = parsePs(out);
  assert.deepStrictEqual(procs.map((p) => p.pid), [1, 842, 1337, 1400]);
  assert.strictEqual(procs[1].ppid, 1);
  assert.strictEqual(procs[2].name, 'node');
  assert.strictEqual(procs[3].name, 'codex');
  // The uuid sits at the very end of the line, so nothing may be truncated.
  assert.ok(procs[3].commandLine.endsWith('01a11bd7-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
});

// macOS reports executable paths that contain spaces, which is exactly why
// `comm` is not one of the requested columns.
test('REGRESSION -- parsePs: survives a macOS path with spaces in it', () => {
  const line = ' 2201 1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=utility';
  const [p] = parsePs(line);
  assert.strictEqual(p.pid, 2201);
  assert.strictEqual(p.commandLine, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=utility');
});

test('parsePs: skips headers, blank lines and argv-less kernel threads', () => {
  assert.deepStrictEqual(parsePs('  PID  PPID ARGS\n\n   3     2 \n'), []);
});

test('normalisePath: folds case only where the filesystem does', () => {
  assert.strictEqual(normalisePath('C:\\Work\\Repo\\', true), 'c:\\work\\repo');
  assert.strictEqual(normalisePath('/home/me/Api/', false), '/home/me/Api');
  assert.notStrictEqual(normalisePath('/home/me/Api', false), normalisePath('/home/me/api', false));
});

// ----------------------------------------------------------------- format --

test('oneLine: flattens and truncates', () => {
  assert.strictEqual(oneLine('a\n  b\tc'), 'a b c');
  assert.strictEqual(oneLine('x'.repeat(50), 10).length, 10);
  assert.strictEqual(oneLine(null), '');
});

// ------------------------------------------------------------- hand-off ----

const handoff = require(path.join(OUT, 'handoff.js'));

test('a hand-off link names an agent, ids and a prompt, and nothing else gets through', () => {
  const ok = handoff.parseHandoff('cwd=C%3A%2Fwork&agent=claude&task=T-abc123&session=6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c&prompt=%E8%AB%8B%E5%85%88%E8%AE%80&title=%E6%95%B4%E7%90%86');
  assert.deepStrictEqual(ok, {
    cwd: 'C:/work', agent: 'claude', task: 'T-abc123', session: '6f1d2c3b-4a5e-4f60-9b7c-8d9e0f1a2b3c',
    resume: false, prompt: '請先讀', title: '整理',
  });
  assert.strictEqual(handoff.parseHandoff('cwd=C%3A%2Fwork').agent, 'claude', 'claude is the default agent');
  assert.strictEqual(handoff.parseHandoff('cwd=C%3A%2Fwork&agent=codex&session=abc12345&resume=1').resume, true);
  for (const bad of [
    '', 'agent=claude', // no folder
    'cwd=x&agent=gemini', // not one of the two agents
    'cwd=x&task=rm%20-rf', 'cwd=x&session=a%20b', // ids that are not ids
    'cwd=x&resume=1', // resume without a conversation
    'cwd=x&prompt=line%0Atwo', // a prompt with a newline
    'cwd=x&prompt=' + 'a'.repeat(501),
  ]) {
    assert.strictEqual(handoff.parseHandoff(bad), null, bad.slice(0, 40));
  }
});

test('the command typed is one of two programs with validated ids and a quoted prompt', () => {
  const req = { cwd: 'C:/w', agent: 'claude', session: 'abc12345-1', resume: false, prompt: "it's \"here\"" };
  assert.strictEqual(handoff.handoffCommand(req, 'powershell'), `claude --session-id abc12345-1 'it''s "here"'`);
  assert.strictEqual(handoff.handoffCommand(req, 'posix'), `claude --session-id abc12345-1 'it'\\''s "here"'`);
  assert.strictEqual(handoff.handoffCommand(req, 'cmd'), `claude --session-id abc12345-1 "it's ""here"""`);
  assert.strictEqual(handoff.handoffCommand({ ...req, resume: true }, 'posix'), `claude --resume abc12345-1 'it'\\''s "here"'`);
  assert.strictEqual(handoff.handoffCommand({ cwd: 'C:/w', agent: 'codex', resume: false }, 'posix'), 'codex');
  assert.strictEqual(handoff.handoffCommand({ cwd: 'C:/w', agent: 'codex', session: 'abc12345', resume: true, prompt: 'go' }, 'powershell'), "codex resume abc12345 'go'");
  assert.strictEqual(handoff.shellKindOf('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
  assert.strictEqual(handoff.shellKindOf('C:/Program Files/PowerShell/7/pwsh.exe'), 'powershell');
  assert.strictEqual(handoff.shellKindOf('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.strictEqual(handoff.shellKindOf('/bin/zsh'), 'posix');
  assert.strictEqual(handoff.shellKindOf(undefined), 'posix');
});

test('a parked hand-off is taken only by the window with that folder, and only while fresh', () => {
  const pending = { cwd: 'C:\\Work\\Proj', agent: 'codex', resume: false, at: 1_000_000 };
  assert.deepStrictEqual(handoff.pendingFor(pending, 'c:/work/proj/', 1_000_000 + 5_000), pending);
  assert.strictEqual(handoff.pendingFor(pending, 'C:/Work/Other', 1_000_000 + 5_000), null);
  assert.strictEqual(handoff.pendingFor(pending, 'C:/Work/Proj', 1_000_000 + handoff.PENDING_HANDOFF_MS + 1), null);
  assert.strictEqual(handoff.pendingFor(undefined, 'C:/Work/Proj'), null);
  assert.strictEqual(handoff.pendingFor(pending, undefined, 1_000_000), null);
});
