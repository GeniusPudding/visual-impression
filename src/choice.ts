// How one record is shown in the Restore terminals picker.
//
// Kept apart from the VS Code shell so the rules can be tested: which rows
// are ticked decides what a bare Enter brings back, and that is the whole
// point of the extension.

import { Preview, oneLine } from './preview';
import { TerminalRecord } from './store';

export interface ChoiceText {
  title: string;
  detail: string;
  picked: boolean;
}

/** Terminal names that are the shell or the agent binary, not a conversation. */
const GENERIC_NAMES = new Set(['', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh', 'fish', 'nu', 'claude', 'codex', 'agy', 'node']);

function isGenericName(name: string | undefined): boolean {
  return GENERIC_NAMES.has((name || '').trim().toLowerCase());
}

/** What reopening does for a conversation whose id was never learned. */
export function noSessionNote(app: string): string {
  if (app === 'agy') {
    return "no session id recorded — reopening continues agy's newest conversation in this folder";
  }
  return `no session id recorded — reopening gives you ${app}'s own picker`;
}

function appName(app: string): string {
  return app === 'codex' ? 'Codex' : app === 'claude' ? 'Claude' : app === 'agy' ? 'Antigravity' : app;
}

/**
 * The row for a record.
 *
 * `preview` is what the conversation's own log says, or null if it could not
 * be read; `previews` says whether logs were looked at at all. A conversation
 * whose log was looked for and not found is listed but left unticked: on
 * this machine `--resume` would open an empty picker, which reads as an
 * ordinary shell having been restored by mistake.
 *
 * An agent row never borrows the terminal's name when that name is just the
 * shell's ("powershell") -- that is exactly what made conversations look like
 * plain terminals in the list.
 */
export function choiceText(rec: TerminalRecord, preview: Preview | null, previews: boolean): ChoiceText {
  if (rec.app === 'shell') {
    return {
      title: rec.title ?? rec.name,
      detail: rec.lastCommand ? '$ ' + oneLine(rec.lastCommand) : '',
      picked: false,
    };
  }
  const missing = Boolean(rec.session) && previews && !preview;
  const named = preview?.title ?? rec.title ?? (isGenericName(rec.name) ? null : rec.name);
  const short = rec.session ? ' ' + rec.session.slice(0, 8) : '';
  const title = named ?? `${appName(rec.app)} conversation${short}`;
  let detail: string;
  if (missing) {
    detail = 'conversation not found on this machine — left unticked';
  } else if (preview?.lastPrompt) {
    detail = '> ' + oneLine(preview.lastPrompt);
  } else if (!rec.session) {
    detail = noSessionNote(rec.app);
  } else {
    detail = '';
  }
  return { title, detail, picked: !missing };
}
