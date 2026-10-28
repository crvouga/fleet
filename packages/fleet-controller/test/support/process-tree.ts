/** pid and every descendant (supervisor, Litestream, worker), parents first. */
export function processTree(root: number): number[] {
  const pids = [root];
  for (const pid of pids)
    pids.push(
      ...Bun.spawnSync(['pgrep', '-P', String(pid)])
        .stdout.toString()
        .split('\n')
        .filter(Boolean)
        .map(Number)
    );
  return pids;
}

/**
 * Drill teardown. Killing only the supervisor would orphan its Litestream and
 * worker (and leave a frozen tree frozen), so resume, then kill the whole tree.
 */
export function killTree(root: number): void {
  for (const pid of processTree(root))
    for (const signal of ['SIGCONT', 'SIGKILL'] as const) {
      try {
        process.kill(pid, signal);
      } catch {
        // already gone
      }
    }
}
