// What a window offers when it opens, and what it must never offer while a
// hand-off from the assistant hub is starting a conversation in it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
const store = require(path.join(OUT, 'store.js'));
const { startupOffer } = require(path.join(OUT, 'handoff.js'));

const closed = (key, session) => ({ key, app: 'claude', session, cwd: 'C:\\work\\repo', closedAt: '2026-11-20T01:00:00.000Z' });
const ixOf = (...terminals) => ({ version: 1, folder: 'C:\\work\\repo', updatedAt: '', terminals });

test('startupOffer: a window opened for 開工 goes straight to the picker', () => {
  assert.strictEqual(startupOffer(true, 3, true), 'picker');
});

test('startupOffer: a window opened by hand still asks first', () => {
  assert.strictEqual(startupOffer(true, 3, false), 'notify');
});

test('startupOffer: nothing to tick, or prompts turned off, offers nothing -- 開工 included', () => {
  assert.strictEqual(startupOffer(true, 0, true), 'none');
  assert.strictEqual(startupOffer(false, 3, true), 'none');
  assert.strictEqual(startupOffer(false, 3, false), 'none');
});

// 開工 resumes conversation s1 in a new terminal; its old record is closed and
// nothing yet says it is open again. Offering it, ticked, would resume s1 a
// second time on Enter -- two programs writing one conversation.
test('REGRESSION -- restorable: the conversation a hand-off is starting is not offered back', () => {
  const ix = ixOf(closed('11:pwsh', 's1'), closed('12:pwsh', 's2'));
  assert.deepStrictEqual(store.restorable(ix).map((t) => t.session).sort(), ['s1', 's2']);
  assert.deepStrictEqual(store.restorable(ix, new Set(), new Set(['s1'])).map((t) => t.session), ['s2']);
});
