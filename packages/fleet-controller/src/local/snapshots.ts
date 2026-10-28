import { rename, writeFile } from 'node:fs/promises';
import type { createRuntime } from '@crvouga/mockingbird-service-s3';

type Runtime = ReturnType<typeof createRuntime>;

export async function restoredS3(path: string) {
  const file = Bun.file(path);
  return (await file.exists()) ? { snapshot: await file.json() } : {};
}

/** Export the documented portable snapshot, never internal emulator state. */
export async function saveS3(runtime: Runtime, path: string) {
  const snapshot = runtime.snapshots.create({ name: 'fleet-local' });
  await writeFile(
    `${path}.tmp`,
    JSON.stringify(runtime.snapshots.export(snapshot.id)),
    { mode: 0o600 }
  );
  await rename(`${path}.tmp`, path);
}
