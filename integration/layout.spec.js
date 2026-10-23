// What only a real VS Code can answer.
//
// The unit tests drive the pane walk against a fake window, which proves the
// algorithm and nothing about VS Code. These run inside an extension host,
// against terminals that are really split, and pin the three things the
// feature rests on: that a terminal created with `location.parentTerminal`
// joins that terminal's tab, that `focusNextPane` cycles within one tab and
// wraps, and that the probe reads a real arrangement correctly.
//
//   npm run test:vscode
//
// THE TRAP, pinned by the first test below. `location.parentTerminal` only
// splits while the parent terminal is still *pending*. The extension host
// sends the parent's `_id`, and the main thread looks it up in a map keyed
// by the id the terminal was created with -- but `_id` is replaced by the
// numeric instance id once `$acceptTerminalOpened` arrives, after which the
// lookup misses, `_deserializeParentTerminal` returns undefined and the
// terminal is quietly opened in a tab of its own instead. Verified in
// 1.108.2 and 1.143.1. So the panes of one tab must all be created in the
// same tick, with no await in between, which is what `openFor` does.

const assert = require('node:assert');
const path = require('path');
const vscode = require('vscode');

const { probeGroups } = require(path.join(__dirname, '..', 'out', 'layout.js'));

/** Terminals opened by a test, disposed however it ends. */
const opened = [];

function open(name, parent) {
  const term = vscode.window.createTerminal(
    parent ? { name, location: { parentTerminal: parent } } : { name },
  );
  term.show(false);
  opened.push(term);
  return term;
}

/** One tab: every pane created in this tick, as the restore does it. */
function openTab(...names) {
  const panes = [];
  for (const name of names) {
    panes.push(open(name, panes[panes.length - 1]));
  }
  return panes;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Terminals exist before their processes do. */
function attached(terminals) {
  return Promise.all(terminals.map((t) => t.processId));
}

/** Focus moves through an event; wait for one, or `ms`, whichever is first. */
function settled(ms = 500) {
  return new Promise((resolve) => {
    const sub = vscode.window.onDidChangeActiveTerminal(() => {
      sub.dispose();
      clearTimeout(timer);
      resolve();
    });
    const timer = setTimeout(() => {
      sub.dispose();
      resolve();
    }, ms);
  });
}

async function nextPane() {
  await vscode.commands.executeCommand('workbench.action.terminal.focusNextPane');
  await settled();
  return vscode.window.activeTerminal && vscode.window.activeTerminal.name;
}

/** The probe from src/layout.ts, driven by the real window, keyed by name. */
function driver(terminals) {
  const byName = new Map(terminals.map((t) => [t.name, t]));
  return {
    ids: terminals.map((t) => t.name),
    activate: async (id) => {
      byName.get(id).show(false);
      await settled();
    },
    next: async () => {
      await vscode.commands.executeCommand('workbench.action.terminal.focusNextPane');
      await settled();
    },
    active: () => vscode.window.activeTerminal && vscode.window.activeTerminal.name,
  };
}

describe('Visual Impression, in a real VS Code', function () {
  this.timeout(90000);

  before(async () => {
    // Terminals left behind by a previous run come back with the window.
    for (const t of vscode.window.terminals) {
      t.dispose();
    }
    await sleep(800);
    await vscode.commands.executeCommand('workbench.action.terminal.toggleTerminal');
    await sleep(800);
  });

  afterEach(async () => {
    while (opened.length) {
      opened.pop().dispose();
    }
    await sleep(500);
  });

  it('puts a terminal created with a parentTerminal in that terminal tab', async () => {
    const [first, second] = openTab('vi-a', 'vi-b');
    await attached([first, second]);
    await sleep(800);

    first.show(false);
    await settled();
    assert.strictEqual(vscode.window.activeTerminal.name, 'vi-a');
    assert.strictEqual(
      await nextPane(),
      'vi-b',
      'focusNextPane moves only within a tab, so reaching vi-b proves they share one',
    );
  });

  it('wraps focusNextPane round the panes of one tab', async () => {
    const panes = openTab('vi-1', 'vi-2', 'vi-3');
    await attached(panes);
    await sleep(800);

    panes[0].show(false);
    await settled();
    assert.deepStrictEqual(
      [await nextPane(), await nextPane(), await nextPane()],
      ['vi-2', 'vi-3', 'vi-1'],
      'three panes, then round again',
    );
  });

  it('reads a real arrangement of tabs and panes', async () => {
    const all = [...openTab('g-a1', 'g-a2'), ...openTab('g-b1'), ...openTab('g-c1', 'g-c2', 'g-c3')];
    await attached(all);
    await sleep(1200);

    const mine = vscode.window.terminals.filter((t) => t.name.startsWith('g-'));
    assert.strictEqual(mine.length, 6, 'all six terminals are open');

    const groups = await probeGroups(driver(mine));
    const shape = groups
      .map((g) => g.slice().sort())
      .sort((x, y) => x[0].localeCompare(y[0]));
    assert.deepStrictEqual(
      shape,
      [
        ['g-a1', 'g-a2'],
        ['g-b1'],
        ['g-c1', 'g-c2', 'g-c3'],
      ],
      'the membership of every tab, read off a real window',
    );
  });

  // The walk moves focus, and VS Code cannot say where focus was before it,
  // so by default it runs only when asked. Pinned against the real
  // contribution, not the TypeScript constant.
  it('reads the arrangement only on request unless told otherwise', () => {
    const cfg = vscode.workspace.getConfiguration('visualImpression');
    assert.strictEqual(cfg.get('rememberLayout'), 'manual');
    assert.strictEqual(cfg.get('rememberLayoutAfterSeconds'), 20);
  });

  it('stops moving focus the moment the walk is interrupted', async () => {
    const panes = openTab('vi-x', 'vi-y', 'vi-z');
    await attached(panes);
    await sleep(800);

    const d = driver(panes);
    let steps = 0;
    const next = d.next;
    d.next = async () => {
      steps++;
      await next();
    };
    d.interrupted = () => steps >= 1; // the window came back after the first move

    assert.strictEqual(await probeGroups(d), null, 'a reading cut short is not reported');
    assert.strictEqual(steps, 1, 'no step after the interruption');
    assert.strictEqual(
      vscode.window.activeTerminal && vscode.window.activeTerminal.name,
      'vi-y',
      'focus is where the one move left it, and went no further',
    );
  });

  it('registers the extension and its commands', async () => {
    assert.ok(
      vscode.extensions.getExtension('geniuspudding.visual-impression'),
      'the extension under test is loaded in this host',
    );
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'visualImpression.restoreTerminals',
      'visualImpression.showStatus',
      'visualImpression.rememberLayoutNow',
      'visualImpression.forgetWorkspace',
    ]) {
      assert.ok(commands.includes(id), id + ' is registered');
    }
  });
});
