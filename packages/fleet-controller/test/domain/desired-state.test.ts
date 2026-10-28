import { describe, expect, test } from 'bun:test';

import { validateConfig } from '../../src/config/schema';
import {
  closureFor,
  convergenceOf,
  desiredFor,
  desiredRevision,
} from '../../src/domain/desired-state';
import type { NodeRow } from '../../src/types';

function node(over: Partial<NodeRow> = {}): NodeRow {
  return {
    approval: 'approved',
    role: 'ci',
    hardware: null,
    observedClosure: 'ci',
    appliedRevision: null,
    reconcile: { phase: 'converged', issues: [] },
    ...over,
  } as NodeRow;
}

describe('closureFor', () => {
  test('picks the first registry closure whose capabilities the hardware has', () => {
    expect(closureFor('ci', ['gpu'])).toBe('ci-gpu');
    expect(closureFor('ci', [])).toBe('ci');
    expect(closureFor('ci', ['tpu'])).toBe('ci');
  });

  test('a role without capability variants keeps its own closure', () => {
    expect(closureFor('devbox', ['gpu'])).toBe('devbox');
    expect(closureFor('devbox', [])).toBe('devbox');
  });

  test('a retired role falls back to its own name', () => {
    expect(closureFor('web', ['gpu'])).toBe('web');
  });
});

describe('desiredFor', () => {
  test('pending, rejected and retired nodes keep what they run and learn only the interval', () => {
    for (const approval of ['pending', 'rejected', 'retired'] as const) {
      expect(
        desiredFor(node({ approval }), {
          sync: { paused: true },
          heartbeat: { intervalSeconds: 30 },
        })
      ).toMatchObject({
        role: null,
        closure: null,
        values: { heartbeat: { intervalSeconds: 30 } },
      });
    }
  });

  test('approved: base without a role, else the closure for role and hardware, never alerts', () => {
    expect(desiredFor(node({ role: null }), {})).toMatchObject({
      role: null,
      closure: 'base',
    });
    const gpu = desiredFor(node({ hardware: { capabilities: ['gpu'] } }), {
      alerts: { offlineAfterSeconds: 120 },
      sync: { paused: true },
    });
    expect(gpu).toMatchObject({
      role: 'ci',
      closure: 'ci-gpu',
      values: { sync: { paused: true } },
    });
    expect(JSON.stringify(gpu)).not.toContain('alerts');
  });

  test('the revision is 16 hex over the canonical role, closure and values', () => {
    const state = desiredFor(node(), { sync: { paused: true } });
    expect(state.revision).toMatch(/^[0-9a-f]{16}$/);
    expect(state.revision).toBe(
      desiredRevision({
        values: { sync: { paused: true } },
        closure: 'ci',
        role: 'ci',
      })
    );
    const revisions = new Set([
      state.revision,
      desiredFor(node({ role: 'devbox' }), { sync: { paused: true } }).revision,
      desiredFor(node({ hardware: { capabilities: ['gpu'] } }), {
        sync: { paused: true },
      }).revision,
      desiredFor(node(), { sync: { paused: false } }).revision,
    ]);
    expect(revisions.size).toBe(4);
  });
});

describe('convergenceOf', () => {
  const desired = { revision: '0123456789abcdef', closure: 'ci' };
  const applied = { appliedRevision: desired.revision };

  test('converged needs the closure, the revision and the node saying so', () => {
    expect(convergenceOf(node(applied), desired)).toBe('converged');
    expect(convergenceOf(node(), desired)).toBe('progressing');
    expect(
      convergenceOf(node({ ...applied, observedClosure: 'base' }), desired)
    ).toBe('progressing');
    expect(
      convergenceOf(
        node({ ...applied, reconcile: { phase: 'progressing', issues: [] } }),
        desired
      )
    ).toBe('progressing');
  });

  test('blocked when the node says so; unknown before a v2 report', () => {
    expect(
      convergenceOf(
        node({ reconcile: { phase: 'blocked', issues: ['x'] } }),
        desired
      )
    ).toBe('blocked');
    expect(
      convergenceOf(node({ observedClosure: null, reconcile: null }), desired)
    ).toBe('unknown');
  });

  test('a null desired closure accepts whatever runs', () => {
    expect(
      convergenceOf(node({ ...applied, observedClosure: 'devbox' }), {
        ...desired,
        closure: null,
      })
    ).toBe('converged');
  });
});

describe('devbox.authorizedKeys', () => {
  const key = (body: string) => ({ devbox: { authorizedKeys: [body] } });
  const ed25519 = `ssh-ed25519 ${'A'.repeat(68)}`;

  test('accepts OpenSSH public keys with an optional plain comment', () => {
    for (const line of [
      ed25519,
      `${ed25519} dana@laptop`,
      `ecdsa-sha2-nistp256 ${'B'.repeat(140)}= ops key`,
      `sk-ssh-ed25519@openssh.com ${'C'.repeat(80)}`,
      `ssh-rsa ${'D'.repeat(372)}==`,
    ])
      expect(validateConfig(key(line)).ok).toBe(true);
  });

  test('refuses options, newlines, unknown types, duplicates and more than 16', () => {
    for (const line of [
      `command="sh" ${ed25519}`,
      `${ed25519}\nssh-ed25519 ${'E'.repeat(68)}`,
      `ssh-dss ${'A'.repeat(68)}`,
      'ssh-ed25519 short',
      `${ed25519} bad"comment`,
      '',
    ])
      expect(validateConfig(key(line)).ok).toBe(false);
    expect(
      validateConfig({ devbox: { authorizedKeys: [ed25519, ed25519] } }).ok
    ).toBe(false);
    const many = Array.from(
      { length: 17 },
      (_, i) => `ssh-ed25519 ${'A'.repeat(60)}${String(i).padStart(8, 'A')}`
    );
    expect(validateConfig({ devbox: { authorizedKeys: many } }).ok).toBe(false);
    expect(validateConfig({ devbox: { rootKeys: [ed25519] } }).ok).toBe(false);
  });
});
