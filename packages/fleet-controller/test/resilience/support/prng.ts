/**
 * A tiny seeded linear congruential generator (Numerical Recipes constants).
 * Randomized resilience tests use it so a failure names its seed and replays
 * exactly; nothing here touches Math.random or the wall clock.
 */
export interface Prng {
  /** The next float in [0, 1). */
  next(): number;
  /** An integer in [0, bound). */
  int(bound: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
}

const MODULUS = 2 ** 32;
const MULTIPLIER = 1664525;
const INCREMENT = 1013904223;

export function prng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, MULTIPLIER) + INCREMENT) >>> 0;
    return state / MODULUS;
  };
  const int = (bound: number): number => Math.floor(next() * bound);
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
    chance: (probability) => next() < probability,
  };
}
