const ROLLBACK = /^(.*) \(rollback to #(\d+)\)$/;

/** The history entry a write restored, or null for an ordinary edit. */
export function rollbackOf(changedBy: string | null): number | null {
  const match = ROLLBACK.exec(changedBy ?? '');
  return match?.[2] === undefined ? null : Number(match[2]);
}

/** Who made the change, without the rollback marker. */
export function authorOf(changedBy: string | null): string {
  const match = ROLLBACK.exec(changedBy ?? '');
  return match?.[1] ?? changedBy ?? 'unknown';
}
