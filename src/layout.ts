// Reading the arrangement of the terminal panes.
//
// VS Code does not report it. `window.terminals` is a flat list, `Terminal`
// has no group, and the arrangement VS Code stores for itself -- the
// `terminal.integrated.layoutInfo` entry in the workspace's state.vscdb --
// identifies each pane by a persistent process id the extension API never
// hands out, so even reading that file would not say which pane held which
// conversation.
//
// What does work: `workbench.action.terminal.focusNextPane` moves focus to
// the next pane of the active terminal's tab and wraps at the end, and
// `window.activeTerminal` says where focus landed. Cycling until it comes
// back to where it started walks exactly one tab. Doing that for every
// terminal reads the whole arrangement, at the price of moving focus about
// while it runs.
//
// That price is the whole problem. The API cannot say where focus was before
// the walk -- in a terminal, in an editor, in a chat panel -- so there is no
// way to put it back there. A walk that runs by itself therefore leaves focus
// in a terminal, and whoever comes back to the window typing finds their
// keystrokes in a shell. So the walk is run on request by default, and the
// automatic pass is opt-in, waits until the window has been left alone for a
// while, and stops the moment the window is in use again.

/** The window, as the probe needs to see it. Fake it and the walk is testable. */
export interface PaneProbe {
  /** Every terminal, in the order VS Code lists them. */
  ids: readonly string[];
  /** Make this terminal the active one. */
  activate(id: string): Promise<void>;
  /** Focus the next pane within the active terminal's tab. */
  next(): Promise<void>;
  /** Which terminal is active now, if any. */
  active(): string | undefined;
  /**
   * Whether to stop: the window is being used again. Asked before every
   * step, so at most one more focus move happens after it says so.
   */
  interrupted?(): boolean;
}

/**
 * The terminals of each tab, tabs in the order their first terminal appears
 * in `ids` -- or null if the walk was interrupted, because a reading that
 * stopped halfway would file the unvisited terminals as a tab each.
 *
 * The membership is exact. The order within a tab is not quite: the walk
 * enters each tab at its earliest-listed terminal and wraps from there, and
 * `ids` is creation order, so a tab reads left to right only if its panes
 * were split in the order they were created. A pane dragged sideways
 * afterwards reads in its original place. Membership is the part that was
 * costing whole tabs; this is the part that is approximate.
 */
export async function probeGroups(p: PaneProbe): Promise<string[][] | null> {
  const left = new Set(p.ids);
  const groups: string[][] = [];
  const stop = (): boolean => p.interrupted?.() === true;

  for (const start of p.ids) {
    if (!left.has(start)) {
      continue;
    }
    if (stop()) {
      return null;
    }
    left.delete(start);
    const cycle = [start];
    await p.activate(start);
    // The probe could not take control -- another window owns focus, or the
    // terminal went away mid-walk. One terminal, one tab, and carry on.
    if (p.active() === start) {
      for (let step = 0; step < p.ids.length; step++) {
        if (stop()) {
          return null;
        }
        await p.next();
        const now = p.active();
        if (!now || now === start || !left.has(now)) {
          break; // wrapped round, or walked into a tab already accounted for
        }
        left.delete(now);
        cycle.push(now);
      }
    }
    groups.push(cycle);
  }
  return groups;
}

/** Whether two readings describe the same set of terminals. */
export function sameTerminals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

/** A reading older than this is re-taken: panes can be dragged, silently. */
export const LAYOUT_STALE_MS = 900_000;

/** What the automatic pass looks at before deciding to walk. */
export interface AutoReadInput {
  /** `visualImpression.rememberLayout`. */
  mode: string;
  /** Whether the window has focus right now. */
  focused: boolean;
  /** How long the window has been without focus. */
  unfocusedForMs: number;
  /** How long it must have been without focus before a walk may start. */
  graceMs: number;
  /** Terminals with a shell pid, which is what a reading is keyed on. */
  terminals: number;
  /** Whether there is an active terminal to hand focus back to. */
  hasActiveTerminal: boolean;
  /** Whether the terminals are the same set the last reading covered. */
  unchanged: boolean;
  /** How old that last reading is. */
  lastReadAgeMs: number;
}

export type AutoReadVerdict =
  | 'read'
  | 'off'
  | 'manual'
  | 'focused'
  | 'too-soon'
  | 'too-few'
  | 'no-active-terminal'
  | 'fresh';

/**
 * Whether the automatic pass should walk the panes now, and if not, why.
 *
 * Every reason but `read` means focus is left alone. Only `onBlur` ever
 * walks by itself; it waits out the grace period so that a glance at another
 * window does not start a walk that the return interrupts, and it does not
 * repeat a reading of the same terminals until it has gone stale.
 */
export function autoReadVerdict(i: AutoReadInput): AutoReadVerdict {
  if (i.mode === 'off') {
    return 'off';
  }
  if (i.mode !== 'onBlur') {
    return 'manual';
  }
  if (i.focused) {
    return 'focused';
  }
  if (i.unfocusedForMs < i.graceMs) {
    return 'too-soon';
  }
  if (!i.hasActiveTerminal) {
    return 'no-active-terminal';
  }
  if (i.terminals < 2) {
    return 'too-few';
  }
  if (i.unchanged && i.lastReadAgeMs < LAYOUT_STALE_MS) {
    return 'fresh';
  }
  return 'read';
}
