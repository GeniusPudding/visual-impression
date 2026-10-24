// When is it safe to type into a terminal that was just created?
//
// Not at once. The shell is still starting; PowerShell in particular draws
// its prompt and answers terminal queries during the first second, and a
// byte that arrives in that window can be eaten -- `claude --resume …` came
// out as `laude --resume …`. VS Code's shell integration reports when the
// shell is up, so text waits for that report, with a cap for shells that
// never give one.

export interface Disposable {
  dispose(): void;
}

/** Resolves true once `onReady` fires (or `already` is set), false when `timeoutMs` passes first. */
export function whenReady(
  already: boolean,
  onReady: (fire: () => void) => Disposable,
  timeoutMs: number,
  timers: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void } = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
  },
): Promise<boolean> {
  if (already) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (ready: boolean) => {
      if (done) {
        return;
      }
      done = true;
      timers.clear(timer);
      sub.dispose();
      resolve(ready);
    };
    const sub = onReady(() => finish(true));
    const timer = timers.set(() => finish(false), timeoutMs);
  });
}

/** How long to wait for the shell before typing anyway. */
export const SHELL_READY_TIMEOUT_MS = 4000;
