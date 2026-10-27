import { useCallback, useEffect, useState } from 'react';
import { decodeState, messageOf, type ConsoleState } from './model';
import { statePoll } from './poll';
export function useConsoleResource(path: string) {
  const [data, setData] = useState<ConsoleState>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    const poll = statePoll({
      read: async (signal) => {
        setLoading(true);
        const response = await fetch(
          `/ui/state?${new URLSearchParams({ path, next: new URLSearchParams(path.split('?')[1]).get('next') ?? '/', error: new URLSearchParams(path.split('?')[1]).get('error') ?? '' })}`,
          { credentials: 'same-origin', signal, cache: 'no-store' }
        );
        if (!response.ok && response.status !== 401)
          throw new Error('Fleet is unavailable. Try again shortly.');
        return decodeState(await response.text());
      },
      success: (next) => {
        setData(next);
        setError('');
      },
      failure: (cause) => setError(messageOf(cause)),
      settled: () => setLoading(false),
    });
    void poll.load();
    const timer = setInterval(() => {
      if (!paused && !document.hidden) void poll.load();
    }, 10_000);
    return () => {
      poll.stop();
      clearInterval(timer);
    };
  }, [path, version, paused]);
  return { data, error, loading, paused, setPaused, reload };
}
