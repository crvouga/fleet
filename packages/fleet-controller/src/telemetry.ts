/** Bounded hardware samples and allowlisted diagnostics, never job output. */
export interface FilesystemSample {
  readonly mount: string;
  readonly totalBytes: number;
  readonly usedBytes: number;
  readonly availableBytes: number;
}
export interface RunnerSlotSample {
  readonly slot: string;
  readonly state: 'idle' | 'busy' | 'offline';
  readonly repository: string | null;
  readonly runId: string | null;
  readonly jobName: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly result: string | null;
}
export interface DiagnosticSample {
  readonly at: string;
  readonly source: string;
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
}
export interface Telemetry {
  readonly sampledAt: string;
  readonly cpuUsagePercent: number | null;
  readonly filesystems: readonly FilesystemSample[];
  readonly temperatures: readonly {
    readonly name: string;
    readonly celsius: number;
  }[];
  readonly power: readonly {
    readonly name: string;
    readonly watts: number;
    readonly source: 'hwmon' | 'powercap';
  }[];
  readonly swap: {
    readonly totalBytes: number;
    readonly usedBytes: number;
  } | null;
  readonly network: readonly {
    readonly name: string;
    readonly receivedBytes: number;
    readonly transmittedBytes: number;
    readonly receiveBytesPerSecond: number | null;
    readonly transmitBytesPerSecond: number | null;
  }[];
  readonly runnerSlots: readonly RunnerSlotSample[];
  readonly logs: readonly DiagnosticSample[];
  readonly issues: readonly string[];
}
