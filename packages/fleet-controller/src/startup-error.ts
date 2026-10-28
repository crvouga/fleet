/** Only operator-facing messages authored here are safe to log at startup. */
export class StartupError extends Error {
  constructor(
    readonly stage: string,
    message: string
  ) {
    super(message);
    this.name = 'StartupError';
  }
}

export function databaseFailure(error: unknown): StartupError {
  if (error instanceof StartupError) return error;
  const code = errorCode(error);
  if (code === 'EADDRINUSE')
    return new StartupError(
      'listen',
      'PORT is already in use. Stop the other Fleet process or choose an unused PORT; run only one writer for this database.'
    );
  if (code === 'EACCES')
    return new StartupError(
      'permissions',
      'Permission denied. Use an unprivileged PORT (1024–65535) and give the service user read/write access to FLEET_DATABASE_PATH and its directory.'
    );
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED')
    return new StartupError(
      'database',
      'SQLite is locked. Stop the other process using FLEET_DATABASE_PATH and retry; only one Fleet controller may own this database.'
    );
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB')
    return new StartupError(
      'database',
      'The SQLite working file is corrupt or is not a database. Stop Fleet, preserve the entire working directory, then restore into an empty directory from your Litestream replica. See CONFIGURATION.md.'
    );
  return new StartupError(
    'database',
    'SQLite initialization or schema validation failed. Check FLEET_DATABASE_PATH permissions and free disk space. If this file came from a newer Fleet version, run that version; otherwise preserve the working directory and restore a verified replica. See CONFIGURATION.md.'
  );
}

function errorCode(error: unknown): unknown {
  if (error && typeof error === 'object' && 'code' in error) return error.code;
  return undefined;
}
