/** A controller failure remembered for a while, so a request id on an error page can become a report. */
export interface ControllerErrorRecord {
  readonly requestId: string;
  readonly at: Date;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly name: string;
  readonly message: string;
  /** The top stack frames only. */
  readonly stack: readonly string[];
}

export interface ErrorRing {
  record(entry: ControllerErrorRecord): void;
  find(requestId: string): ControllerErrorRecord | undefined;
  recent(limit: number): readonly ControllerErrorRecord[];
}

const RING_SIZE = 100;
const STACK_FRAMES = 12;

/** Bounded, in memory, newest wins. A restart forgets it; the report keeps what it saved. */
export function createErrorRing(size = RING_SIZE): ErrorRing {
  const entries: ControllerErrorRecord[] = [];
  return {
    record(entry) {
      entries.push(entry);
      if (entries.length > size) entries.shift();
    },
    find: (requestId) => entries.find((entry) => entry.requestId === requestId),
    recent: (limit) => entries.slice(-limit).reverse(),
  };
}

/** The error as a record: name, message and top frames; never the cause chain's payloads. */
export function describeError(
  error: unknown,
  context: Omit<ControllerErrorRecord, 'name' | 'message' | 'stack'>
): ControllerErrorRecord {
  const known = error instanceof Error;
  return {
    ...context,
    name: known ? error.name : 'NonError',
    message: known ? error.message : String(error),
    stack: known
      ? (error.stack ?? '')
          .split('\n')
          .slice(1, STACK_FRAMES + 1)
          .map((line) => line.trim())
      : [],
  };
}
