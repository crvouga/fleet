import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<Record<string, unknown>>();

export function logContext(): Record<string, unknown> {
  return context.getStore() ?? {};
}

export function withLogContext<T>(
  fields: Record<string, unknown>,
  work: () => T
): T {
  return context.run({ ...logContext(), ...fields }, work);
}

export class OperationError extends Error {
  constructor(
    readonly operation: string,
    cause: unknown
  ) {
    super(`Operation failed: ${operation}`, { cause });
    this.name = 'OperationError';
  }
}

export async function operation<T>(
  name: string,
  work: () => PromiseLike<T>
): Promise<T> {
  try {
    return await withLogContext({ operation: name }, work);
  } catch (error) {
    throw new OperationError(name, error);
  }
}
