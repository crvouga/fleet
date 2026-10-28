import { describe, expect, test } from 'bun:test';

import { hmacHex, safeEqual, sha256Hex } from '../../src/auth/hash';
import { parseNodeCredential } from '../../src/auth/node-credential';
import { matchEnrollmentToken } from '../../src/auth/enrollment-token';
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

describe('matchEnrollmentToken', () => {
  const ci = { sha256: sha256('ci-token-0001'), role: 'ci' as const };
  const plain = { sha256: sha256('plain-token-0001'), role: null };
  const entries = [ci, plain];

  test('returns the entry whose hash matches, with its role', () => {
    expect(matchEnrollmentToken(entries, 'ci-token-0001')).toBe(ci);
    expect(matchEnrollmentToken(entries, 'plain-token-0001')).toBe(plain);
  });

  test('refuses missing, empty, wrong, padded and malformed tokens', () => {
    for (const token of [
      undefined,
      '',
      'nope-nope',
      'ci-token-0001 ',
      ' ci-token-0001',
      'CI-TOKEN-0001',
      'short',
      'ci token 0001',
    ]) {
      expect(matchEnrollmentToken(entries, token)).toBeNull();
    }
  });

  test('no configured tokens never approves', () => {
    expect(matchEnrollmentToken([], 'ci-token-0001')).toBeNull();
    expect(
      matchEnrollmentToken([{ sha256: sha256(''), role: null }], '')
    ).toBeNull();
  });

  test('tokens longer than 512 characters are refused', () => {
    const huge = 'x'.repeat(513);
    expect(
      matchEnrollmentToken([{ sha256: sha256(huge), role: 'ci' }], huge)
    ).toBeNull();
    const max = 'x'.repeat(512);
    expect(
      matchEnrollmentToken([{ sha256: sha256(max), role: 'ci' }], max)
    ).not.toBeNull();
  });
});
