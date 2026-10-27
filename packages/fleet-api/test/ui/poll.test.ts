import { expect, test } from 'bun:test';
import { statePoll } from '../../src/console/poll';

test('single-flight polling cannot replace a newer page with a late response', async () => {
  let complete!: (value: string) => void;
  let signal: AbortSignal | undefined;
  const values: string[] = [];
  const poll = statePoll({
    read: (input) => {
      signal = input;
      return new Promise<string>((resolve) => {
        complete = resolve;
      });
    },
    success: (value) => values.push(value),
    failure: () => {},
    settled: () => {},
  });
  const pending = poll.load();
  await poll.load();
  poll.stop();
  expect(signal?.aborted).toBe(true);
  complete('old-page');
  await pending;
  expect(values).toEqual([]);
});
test('polling releases its request on failure and can recover', async () => {
  let attempts = 0;
  const values: string[] = [];
  const errors: unknown[] = [];
  const poll = statePoll({
    read: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('offline');
      return 'recovered';
    },
    success: (value) => values.push(value),
    failure: (error) => errors.push(error),
    settled: () => {},
  });
  await poll.load();
  await poll.load();
  poll.stop();
  expect(errors).toHaveLength(1);
  expect(values).toEqual(['recovered']);
});
