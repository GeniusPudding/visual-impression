// The vscode:// handler guard around the integration run (scripts/url-handler.mjs).

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

// An ES module, so it is imported by URL: a bare Windows path is read as the scheme `c:`.
const mod = () => import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'url-handler.mjs')).href);

test('parseRegQuery reads the default value whatever the system calls it', async () => {
  const { parseRegQuery } = await mod();
  const english = [
    '',
    'HKEY_CURRENT_USER\\Software\\Classes\\vscode\\shell\\open\\command',
    '    (Default)    REG_SZ    "C:\\apps\\Code\\Code.exe" --open-url -- "%1"',
    '',
  ].join('\r\n');
  assert.strictEqual(parseRegQuery(english), '"C:\\apps\\Code\\Code.exe" --open-url -- "%1"');
  const chinese = '    (預設)    REG_SZ    "C:\\apps\\Code\\Code.exe" --open-url -- "%1"\r\n';
  assert.strictEqual(parseRegQuery(chinese), '"C:\\apps\\Code\\Code.exe" --open-url -- "%1"');
  assert.strictEqual(parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), null);
  assert.strictEqual(parseRegQuery(''), null);
});

test('handlerChanged: only a handler that was there and is now different needs putting back', async () => {
  const { handlerChanged } = await mod();
  const a = '"C:\\apps\\Code\\Code.exe" --open-url -- "%1"';
  const b = '"C:\\work\\.vscode-test\\Code.exe" --open-url -- "%1"';
  assert.strictEqual(handlerChanged(a, b), true);
  assert.strictEqual(handlerChanged(a, a), false);
  assert.strictEqual(handlerChanged(null, b), false, 'nothing was set before: nothing to restore');
  assert.strictEqual(handlerChanged(a, null), true, 'the key went: put it back');
});

test('a handler command survives the round trip through the registry', { skip: process.platform !== 'win32' }, async () => {
  const { readHandler, writeHandler, deleteKey } = await mod();
  const key = 'HKCU\\Software\\visual-impression-test\\url-handler\\shell\\open\\command';
  const command = '"C:\\apps\\Code\\Code.exe" --open-url -- "%1"';
  try {
    assert.strictEqual(readHandler(key), null, 'the throwaway key does not exist yet');
    assert.strictEqual(writeHandler(command, key), true);
    assert.strictEqual(readHandler(key), command, 'quotes and %1 come back as written');
  } finally {
    deleteKey('HKCU\\Software\\visual-impression-test');
  }
  assert.strictEqual(readHandler(key), null);
});
