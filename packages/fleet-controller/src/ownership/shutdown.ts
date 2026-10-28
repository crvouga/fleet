/** The platform asked this process to stop (SIGTERM/SIGINT). */
export interface Shutdown {
  readonly requested: () => boolean;
  readonly promise: Promise<void>;
  /** Resolves after ms, or as soon as shutdown is requested. */
  readonly sleep: (ms: number) => Promise<void>;
  dispose(): void;
}

export function shutdownSignal(): Shutdown {
  let requested = false;
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => (resolve = done));
  const handler = () => {
    requested = true;
    resolve();
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  return {
    requested: () => requested,
    promise,
    // A waiting instance has nothing else keeping it alive, so this timer must not be unref'd.
    sleep: (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise,
        new Promise<void>((done) => (timer = setTimeout(done, ms))),
      ]).finally(() => clearTimeout(timer));
    },
    dispose: () => {
      process.off('SIGTERM', handler);
      process.off('SIGINT', handler);
    },
  };
}
