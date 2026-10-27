/** One bounded request at a time; cleanup cancels work before another page loads. */
export function statePoll<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  success: (value: T) => void;
  failure: (cause: unknown) => void;
  settled: () => void;
  timeoutMs?: number;
}) {
  let controller: AbortController | undefined;
  let stopped = false;
  return {
    async load(): Promise<void> {
      if (stopped || controller) return;
      const request = new AbortController();
      controller = request;
      const timer = setTimeout(
        () =>
          request.abort(
            new Error(
              'Fleet request timed out. Showing the last successful report.'
            )
          ),
        options.timeoutMs ?? 20_000
      );
      try {
        const value = await options.read(request.signal);
        if (!stopped && !request.signal.aborted) options.success(value);
      } catch (cause) {
        if (!stopped) options.failure(request.signal.reason ?? cause);
      } finally {
        clearTimeout(timer);
        controller = undefined;
        if (!stopped) options.settled();
      }
    },
    stop() {
      stopped = true;
      controller?.abort();
    },
  };
}
