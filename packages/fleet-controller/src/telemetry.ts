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
/**
 * How a metric family was obtained. `measured` is read from a counter or a tool,
 * `estimated` is inferred, `unsupported` could not be provided (see `reason`).
 * Staleness is a property of the whole sample's age and is derived on read.
 */
export type Provenance = 'measured' | 'estimated' | 'unsupported';
export interface FamilyBase {
  readonly status: Provenance;
  readonly reason: string | null;
}
export interface GpuSample {
  readonly name: string;
  readonly vendor: 'nvidia' | 'amd' | 'intel';
  readonly utilizationPercent: number | null;
  readonly memoryUsedBytes: number | null;
  readonly memoryTotalBytes: number | null;
  readonly temperatureCelsius: number | null;
  readonly powerWatts: number | null;
}
export interface DiskIoSample {
  readonly name: string;
  readonly readBytesPerSecond: number | null;
  readonly writeBytesPerSecond: number | null;
  readonly iops: number | null;
  readonly busyPercent: number | null;
}
export type DiskHealthState = 'ok' | 'warning' | 'failing' | 'unknown';
export interface DiskHealthSample {
  readonly name: string;
  readonly state: DiskHealthState;
  readonly source: 'smartctl' | 'sysfs';
  readonly temperatureCelsius: number | null;
  readonly wearPercent: number | null;
  readonly powerOnHours: number | null;
  readonly detail: string | null;
}
export interface PressureSample {
  readonly someAvg10: number | null;
  readonly someAvg60: number | null;
  readonly fullAvg10: number | null;
  readonly fullAvg60: number | null;
}
export interface GpusFamily extends FamilyBase {
  readonly devices: readonly GpuSample[];
}
export interface DiskIoFamily extends FamilyBase {
  readonly devices: readonly DiskIoSample[];
}
export interface DiskHealthFamily extends FamilyBase {
  readonly devices: readonly DiskHealthSample[];
}
export interface CpuFrequencyFamily extends FamilyBase {
  readonly currentMHz: number | null;
  readonly minMHz: number | null;
  readonly maxMHz: number | null;
}
export interface ThrottlingFamily extends FamilyBase {
  readonly throttled: boolean | null;
  /** Throttle events counted since the previous sample. */
  readonly events: number | null;
  readonly basis: 'thermal_throttle' | 'frequency' | null;
}
export interface PressureFamily extends FamilyBase {
  readonly cpu: PressureSample | null;
  readonly memory: PressureSample | null;
  readonly io: PressureSample | null;
}
export interface ConnectivityFamily extends FamilyBase {
  readonly controllerLatencyMs: number | null;
  readonly consecutiveFailures: number | null;
}
export interface LifecycleSample {
  readonly uptimeSeconds: number | null;
  /** Restarts the agent itself has observed since `trackedSince`. */
  readonly restartCount: number | null;
  readonly trackedSince: string | null;
}
/**
 * Optional since agents that predate them omit them: absent means unknown,
 * never zero. Each family says whether it was measured, estimated or unsupported.
 */
export interface HealthTelemetry {
  readonly gpus?: GpusFamily;
  readonly diskIo?: DiskIoFamily;
  readonly diskHealth?: DiskHealthFamily;
  readonly cpuFrequency?: CpuFrequencyFamily;
  readonly throttling?: ThrottlingFamily;
  readonly pressure?: PressureFamily;
  readonly connectivity?: ConnectivityFamily;
  readonly lifecycle?: LifecycleSample;
}
export interface NetworkSample {
  readonly name: string;
  readonly receivedBytes: number;
  readonly transmittedBytes: number;
  readonly receiveBytesPerSecond: number | null;
  readonly transmitBytesPerSecond: number | null;
  /** Error and drop counts since the previous sample; absent from older agents. */
  readonly receiveErrors?: number | null;
  readonly transmitErrors?: number | null;
  readonly receiveDropped?: number | null;
  readonly transmitDropped?: number | null;
}
export interface Telemetry extends HealthTelemetry {
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
  readonly network: readonly NetworkSample[];
  readonly runnerSlots: readonly RunnerSlotSample[];
  readonly logs: readonly DiagnosticSample[];
  readonly issues: readonly string[];
}
