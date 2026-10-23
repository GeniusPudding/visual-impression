// How the integration tests are run: a real VS Code, this extension loaded,
// an empty folder as the workspace so a developer's own index is never
// touched. `npm run test:vscode`.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  label: 'integration',
  files: 'integration/**/*.spec.js',
  version: 'stable',
  workspaceFolder: './integration/fixture-workspace',
  mocha: { ui: 'bdd', timeout: 60000 },
});
