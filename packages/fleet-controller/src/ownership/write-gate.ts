import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** The environment variable naming the gate file the supervisor shares with the worker. */
export const WRITE_GATE_ENV = 'FLEET_WRITE_LEASE_FILE';

/**
 * Supervisor side: the wall-clock time (ms) until which the worker may
 * acknowledge writes; 0 closes the gate. Written atomically.
 */
export function openGateUntil(path: string, wallMs: number): void {
  const temporary = `${path}.next`;
  writeFileSync(temporary, String(Math.max(0, Math.floor(wallMs))), {
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * Worker side: true while the supervisor still proves ownership. A missing or
 * unreadable file closes the gate, and so does a paused process that resumes
 * after its lease time passed.
 */
export function fileWriteGate(
  path: string,
  now: () => number = Date.now
): () => boolean {
  return () => {
    try {
      return now() < Number(readFileSync(path, 'utf8'));
    } catch {
      return false;
    }
  };
}
