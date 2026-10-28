import { describe, expect, test } from 'bun:test';

import { ConfigurationError, readControllerEnv } from '../src/env';

const BASE = {
  FLEET_S3_BUCKET: 'test-bucket',
  AWS_ACCESS_KEY_ID: 'test-key',
  AWS_SECRET_ACCESS_KEY: 'test-secret',
  FLEET_ADMIN_TOKEN: 'a'.repeat(40),
};

function problemsOf(env: Record<string, string>): string {
  try {
    readControllerEnv({ ...BASE, ...env });
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
  return '';
}

describe('FLEET_ADMIN_TOKEN_NEXT', () => {
  test('is optional and absent by default', () => {
    expect(problemsOf({})).not.toContain('FLEET_ADMIN_TOKEN_NEXT');
  });

  test('follows the same 32 character, no-whitespace rule and names the variable, never the value', () => {
    expect(problemsOf({ FLEET_ADMIN_TOKEN_NEXT: 'short' })).toContain(
      'FLEET_ADMIN_TOKEN_NEXT must be at least 32 characters'
    );
    const spaced = problemsOf({
      FLEET_ADMIN_TOKEN_NEXT: `${'b'.repeat(20)} ${'c'.repeat(20)}`,
    });
    expect(spaced).toContain(
      'FLEET_ADMIN_TOKEN_NEXT must not contain whitespace'
    );
    expect(spaced).not.toContain('bbbbbbbb');
  });

  test('must differ from the current token', () => {
    expect(problemsOf({ FLEET_ADMIN_TOKEN_NEXT: 'a'.repeat(40) })).toContain(
      'FLEET_ADMIN_TOKEN_NEXT must differ from FLEET_ADMIN_TOKEN'
    );
  });

  test('a valid next token is carried alongside the current one', () => {
    const next = 'n'.repeat(40);
    const env = readControllerEnv({ ...BASE, FLEET_ADMIN_TOKEN_NEXT: next });
    expect(env.adminToken).toBe('a'.repeat(40));
    expect(env.adminTokenNext).toBe(next);
  });
});
