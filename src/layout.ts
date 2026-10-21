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
// while it runs -- which is why it is done when the window is not in use.

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
}

/**
 * The terminals of each tab, tabs in the order their first terminal appears
 * in `ids`.
 *
 * The membership is exact. The order within a tab is not quite: the walk
 * enters each tab at its earliest-listed terminal and wraps from there, and
 * `ids` is creation order, so a tab reads left to right only if its panes
 * were split in the order they were created. A pane dragged sideways
 * afterwards reads in its original place. Membership is the part that was
 * costing whole tabs; this is the part that is approximate.
 */
export async function probeGroups(p: PaneProbe): Promise<string[][]> {
  const left = new Set(p.ids);
  const groups: string[][] = [];

  for (const start of p.ids) {
    if (!left.has(start)) {
      continue;
    }
    left.delete(start);
    const cycle = [start];
    await p.activate(start);
    // The probe could not take control -- another window owns focus, or the
    // terminal went away mid-walk. One terminal, one tab, and carry on.
    if (p.active() === start) {
      for (let step = 0; step < p.ids.length; step++) {
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
