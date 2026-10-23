/** Listen before draining so requests arriving during startup cannot be lost.
 * Serialize batches: opening a file may show an autosave recovery dialog. */
export async function connectFileOpen(
  subscribe: (notify: () => void) => Promise<() => void>,
  take: () => Promise<string[]>,
  open: (path: string) => Promise<void>,
  report: (error: unknown) => void = console.error,
): Promise<() => void> {
  let stopped = false;
  let pending = Promise.resolve();
  const drain = () => {
    pending = pending.then(async () => {
      if (stopped) return;
      for (const path of await take()) {
        if (stopped) return;
        try { await open(path); } catch (error) { report(error); }
      }
    }).catch(report);
  };
  const unlisten = await subscribe(drain);
  drain();
  return () => { stopped = true; unlisten(); };
}
