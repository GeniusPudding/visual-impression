# Toolchain

Everything the project needs, what it is for, and where it comes from.
`scripts/setup.sh` (macOS, Linux) and `scripts/setup.ps1` (Windows) install
all of it; running either again is safe.

## Required

| Tool | Version | What uses it | Where it comes from |
|---|---|---|---|
| Node.js | 20 or newer | compiling, the test runner, the extension host | [nodejs.org](https://nodejs.org), or your package manager |
| npm | ships with Node | `npm ci`, the scripts below | with Node |
| VS Code | 1.93 or newer | the extension host, and the `code` CLI the installer calls | [code.visualstudio.com](https://code.visualstudio.com) |

1.93 is the floor because `window.onDidStartTerminalShellExecution`, which
records the last command in a plain terminal, became stable there.

Node 20 is the floor because the tests run on `node --test` with no runner.
Note that `node --test <dir>` means different things on different versions --
on Node 26.1 it reads the directory as a module and fails -- so the test
script passes no path and lets default discovery find `**/*.test.js`.

## Installed by `npm ci`

| Package | What it is for |
|---|---|
| `typescript` | compiles `src/*.ts` to `out/*.js`, which is what ships |
| `@types/vscode` | the extension API types; its version is the API floor |
| `@types/node` | types for `fs`, `os`, `child_process` |
| `@vscode/vsce` | builds the `.vsix` and publishes to the Marketplace |
| `@vscode/test-cli`, `@vscode/test-electron` | download a VS Code and run the integration tests inside it |
| `eslint`, `typescript-eslint` | the lint rules |
| `@eslint/js` | the base rule set those extend |

There are no runtime dependencies. The `.vsix` is built with
`--no-dependencies` and contains nothing but `out/`, the readme, the licence,
the icon and the two setup scripts.

## Optional

| Tool | What for |
|---|---|
| Python 3 | `scripts/make-icon.py`, which draws `media/icon.png`. Only needed to change the icon; it uses the standard library alone. |

## Commands

| Command | What it does |
|---|---|
| `npm run compile` | TypeScript to `out/` |
| `npm run lint` | ESLint over `src/`, `test/` and `integration/` |
| `npm test` | compile, then the unit tests -- no VS Code needed |
| `npm run test:vscode` | downloads VS Code if needed and runs the integration tests in a real extension host |
| `npm run check` | lint, unit tests and integration tests: what CI runs |
| `npm run package` | builds the `.vsix` |
| `scripts/setup.sh`, `scripts/setup.ps1` | the above, then installs into VS Code |
| `scripts/setup.sh --check` | reports what is installed and runs the tests, changing nothing |

## Pipeline

```
src/*.ts  --tsc-->  out/*.js  --vsce-->  visual-impression-<version>.vsix
                        |                          |
                   node --test              code --install-extension
                 @vscode/test-electron
```

## Publishing

Needs an Azure DevOps organisation, a publisher at
[marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
whose id matches `publisher` in `package.json`, and a personal access token
scoped to **Marketplace > Manage** for **All accessible organisations**.
Then `npx vsce login <publisher>` once, and `npx vsce publish` per release.
`vsce login` verifies the token against that publisher, so a token that is
fine elsewhere still fails with `TF400813` until the publisher exists.
