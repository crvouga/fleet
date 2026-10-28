/** Thrown by a store when `putSettings` finds a different revision than the caller expected. */
export class SettingsConflictError extends Error {
  constructor(
    readonly current: number,
    readonly expected: number
  ) {
    super(
      `The settings changed since you loaded them (revision ${current}, you had ${expected}).`
    );
    this.name = 'SettingsConflictError';
  }
}
