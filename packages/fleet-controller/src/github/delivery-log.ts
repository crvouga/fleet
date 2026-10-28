export interface DeliveryLog {
  /** True when this delivery id was already handled (within the window). */
  seen(id: string): boolean;
  /** Remember an id once its delivery has been handled. */
  remember(id: string): void;
}

const MAX_IDS = 4096;
const WINDOW_MS = 24 * 3600 * 1000;

/** Remembers recent webhook delivery ids. Bounded in size and age. */
export function createDeliveryLog(now: () => Date): DeliveryLog {
  const handled = new Map<string, number>();
  return {
    seen(id) {
      const at = handled.get(id);
      return at !== undefined && now().getTime() - at < WINDOW_MS;
    },
    remember(id) {
      const at = now().getTime();
      handled.delete(id);
      handled.set(id, at);
      for (const [key, when] of handled) {
        const stale = at - when >= WINDOW_MS || handled.size > MAX_IDS;
        if (!stale) break;
        handled.delete(key);
      }
    },
  };
}
