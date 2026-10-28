import { describe, expect, test } from 'bun:test';

import { hmacHex, safeEqual, sha256Hex } from '../../src/auth/hash';
import { parseNodeCredential } from '../../src/auth/node-credential';
import { roleTokenValid } from '../../src/auth/role-token';
import { nodeIdOf, secretOf, sha256 } from '../support/fixtures';

describe('safeEqual and hashes', () => {
  test('compares strings of any length without throwing', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('', 'x')).toBe(false);
    expect(safeEqual('é', 'é')).toBe(true);
  });

  test('sha256 and hmac are the standard ones', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(hmacHex('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8'
    );
  });
});

describe('parseNodeCredential', () => {
  const good = `Bearer ${nodeIdOf(1)}.${secretOf(1)}`;

  test('splits the id from the secret and returns only the secret hash', () => {
    expect(parseNodeCredential(good)).toEqual({
      nodeId: nodeIdOf(1),
      secretHash: sha256(secretOf(1)),
    });
  });

  test('refuses everything that is not exactly <64 hex>.<64 hex>', () => {
    const bad = [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Basic ${nodeIdOf(1)}.${secretOf(1)}`,
      `bearer ${nodeIdOf(1)}.${secretOf(1)}`,
      `Bearer ${nodeIdOf(1)}`,
      `Bearer ${nodeIdOf(1)}.`,
      `Bearer .${secretOf(1)}`,
      `Bearer ${nodeIdOf(1).toUpperCase()}.${secretOf(1)}`,
      `Bearer ${nodeIdOf(1)}.${secretOf(1).slice(1)}`,
      `Bearer ${nodeIdOf(1)}.${secretOf(1)}.x`,
      `Bearer ${nodeIdOf(1)}:${secretOf(1)}`,
      `Bearer ${'g'.repeat(64)}.${secretOf(1)}`,
    ];
    for (const header of bad) expect(parseNodeCredential(header)).toBeNull();
  });
});

describe('roleTokenValid', () => {
  const hashes = { ci: sha256('ci-token'), web: sha256('web-token') };

  test('accepts the token for its own role only', () => {
    expect(roleTokenValid(hashes, 'ci', 'ci-token')).toBe(true);
    expect(roleTokenValid(hashes, 'web', 'web-token')).toBe(true);
    expect(roleTokenValid(hashes, 'ci', 'web-token')).toBe(false);
    expect(roleTokenValid(hashes, 'web', 'ci-token')).toBe(false);
  });

  test('refuses missing, empty, wrong and padded tokens', () => {
    for (const token of [
      undefined,
      '',
      'nope',
      'ci-token ',
      ' ci-token',
      'CI-TOKEN',
    ]) {
      expect(roleTokenValid(hashes, 'ci', token)).toBe(false);
    }
  });

  test('a role with no configured token can never be approved this way', () => {
    expect(roleTokenValid(hashes, 'cache', 'anything')).toBe(false);
    expect(roleTokenValid(hashes, 'cache', '')).toBe(false);
    expect(roleTokenValid({}, 'ci', 'ci-token')).toBe(false);
    expect(roleTokenValid({ ci: '0'.repeat(64) }, 'ci', '')).toBe(false);
  });

  test('an enormous token is refused', () => {
    const huge = 'x'.repeat(513);
    expect(roleTokenValid({ ci: sha256(huge) }, 'ci', huge)).toBe(false);
  });
});
