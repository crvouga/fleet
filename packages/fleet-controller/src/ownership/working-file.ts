import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const SIDE_FILES = ['', '-wal', '-shm'];

const markerOf = (path: string) => `${path}.generation`;
/** Litestream 0.5 keeps per-database replication state beside the database. */
const metadataOf = (path: string) =>
  join(dirname(path), `.${basename(path)}-litestream`);

/** Records which replica generation the local working file continues. */
export function markGeneration(path: string, generation: number): void {
  writeFileSync(markerOf(path), String(generation), { mode: 0o600 });
}

function readMarker(path: string): string | null {
  try {
    return readFileSync(markerOf(path), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * True when the working file at `path` continues `generation`: its marker
 * names that generation (a file with no marker belongs to generation 0, the
 * layout that predates ownership).
 */
export function continuesGeneration(path: string, generation: number): boolean {
  const marker = readMarker(path);
  return marker === String(generation) || (marker === null && generation === 0);
}

/**
 * Keeps the local working file only when it continues exactly the generation
 * being restored (it may hold writes not yet replicated). Otherwise another
 * writer moved on, so it is set aside, never deleted, and restored fresh.
 */
export function prepareWorkingFile(
  path: string,
  restoreFrom: number
): 'kept' | 'absent' | 'superseded' {
  if (!existsSync(path)) {
    rmSync(markerOf(path), { force: true });
    return 'absent';
  }
  if (continuesGeneration(path, restoreFrom)) return 'kept';
  for (const suffix of SIDE_FILES) {
    const aside = `${path}.superseded${suffix}`;
    rmSync(aside, { force: true });
    if (existsSync(path + suffix)) renameSync(path + suffix, aside);
  }
  rmSync(metadataOf(path), { recursive: true, force: true });
  rmSync(markerOf(path), { force: true });
  return 'superseded';
}
