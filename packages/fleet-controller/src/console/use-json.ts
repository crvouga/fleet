import { useCallback, useEffect, useState } from 'react';
import { messageOf } from './model';

const DATE_KEYS = new Set([
  'requestedAt',
  'updatedAt',
  'completedAt',
  'at',
  'drainRequestedAt',
]);
const REFRESH_MS = 10_000;

/** Reads a JSON endpoint with the session cookie and refreshes it while the tab is visible. */
export function useJson<T>(url: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch(url, {
          credentials: 'same-origin',
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const text = await response.text();
        if (!response.ok)
          throw new Error(
            response.status === 403
              ? 'Only administrators can see this.'
              : 'Fleet is unavailable. Try again shortly.'
          );
        setData(
          JSON.parse(text, (key, value: unknown) =>
            DATE_KEYS.has(key) && typeof value === 'string'
              ? new Date(value)
              : value
          ) as T
        );
        setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(messageOf(cause));
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [url, version]);
  return { data, error, reload };
}
