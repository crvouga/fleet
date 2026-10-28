/**
 * Preloaded into a spawned supervisor (`bun --preload`) to make it believe
 * `FLEET_TEST_CLOCK_SKEW_MS` more time has passed than has, so object-storage
 * data written moments ago counts as old for retention drills. Test-only; no
 * production code reads this variable.
 */
const skew = Number(process.env['FLEET_TEST_CLOCK_SKEW_MS'] ?? 0);
const real = Date.now.bind(Date);
if (Number.isFinite(skew) && skew !== 0) Date.now = () => real() + skew;
