import type { Telemetry } from '../../src/telemetry';
export function telemetry(overrides: Partial<Telemetry> = {}): Telemetry {
  return {
    sampledAt: '2026-10-14T12:00:00Z',
    cpuUsagePercent: 0,
    filesystems: [
      { mount: '/nix', totalBytes: 1000, usedBytes: 400, availableBytes: 500 },
    ],
    temperatures: [{ name: 'cpu-package', celsius: 42.5 }],
    power: [{ name: 'package-0', watts: 0, source: 'powercap' }],
    swap: { totalBytes: 100, usedBytes: 0 },
    network: [
      {
        name: 'eth0',
        receivedBytes: 1000,
        transmittedBytes: 2000,
        receiveBytesPerSecond: null,
        transmitBytesPerSecond: 0,
      },
    ],
    runnerSlots: [
      {
        slot: 'slot-1',
        state: 'busy',
        repository: 'example/project',
        runId: '123',
        jobName: 'Build',
        startedAt: '2026-10-14T11:59:00Z',
        finishedAt: null,
        result: null,
      },
    ],
    logs: [
      {
        at: '2026-10-14T11:59:00Z',
        source: 'runner:slot-1',
        level: 'info',
        message: 'Runner slot-1 started a job.',
      },
    ],
    issues: [],
    ...overrides,
  };
}

/** Every bounded collection full, without including raw job output. */
export function maximumTelemetry(): Telemetry {
  const sample = telemetry();
  const name = (prefix: string, index: number) =>
    `${prefix}-${index}-${'x'.repeat(80)}`;
  return telemetry({
    filesystems: Array.from({ length: 16 }, (_, index) => ({
      mount: `/${name('mount', index)}`,
      totalBytes: 1000,
      usedBytes: 400,
      availableBytes: 500,
    })),
    temperatures: Array.from({ length: 64 }, (_, index) => ({
      name: name('sensor', index),
      celsius: index,
    })),
    power: Array.from({ length: 32 }, (_, index) => ({
      name: name('domain', index),
      watts: index,
      source: 'powercap',
    })),
    network: Array.from({ length: 32 }, (_, index) => ({
      ...sample.network[0]!,
      name: name('interface', index),
    })),
    runnerSlots: Array.from({ length: 64 }, (_, index) => ({
      ...sample.runnerSlots[0]!,
      slot: `slot-${index + 1}`,
      jobName: 'Build '.repeat(20),
    })),
    logs: Array.from({ length: 40 }, (_, index) => ({
      ...sample.logs[0]!,
      source: `runner:slot-${index + 1}`,
      message: `Runner slot-${index + 1} started a job.`,
    })),
    issues: Array.from({ length: 16 }, (_, index) => name('issue', index)),
  });
}
