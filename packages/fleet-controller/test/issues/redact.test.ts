import { describe, expect, test } from 'bun:test';

import {
  createRedactor,
  looksSecret,
  REDACTED,
  redactText,
} from '../../src/issues/redact';
import {
  between,
  CONTEXTS,
  opaque,
  SECRET_KEYS,
  SECRET_SHAPES,
  seeded,
} from './secrets';

describe('redactText: named shapes', () => {
  test('GitHub tokens of every prefix', () => {
    for (const prefix of ['ghp', 'gho', 'ghs', 'ghu', 'ghr']) {
      const token = `${prefix}_${'a1B2c3D4'.repeat(5)}`;
      expect(redactText(`pushed with ${token} ok`)).toBe(
        `pushed with ${REDACTED} ok`
      );
    }
    const pat = `github_pat_${'A1b2C3d4E5f6'.repeat(6)}`;
    expect(redactText(`x ${pat}`)).not.toContain('A1b2C3d4E5f6');
  });

  test('JWTs, Bearer values and Authorization headers', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r';
    expect(redactText(`id_token ${jwt}`)).not.toContain('eyJzdWIi');
    expect(redactText('Authorization: Bearer abc.def-123')).toBe(
      `Authorization: ${REDACTED}`
    );
    expect(redactText('authorization: Basic dXNlcjpwYXNz')).not.toContain(
      'dXNlcjpwYXNz'
    );
    expect(redactText('retry with Bearer sk_live_1234567890')).toBe(
      `retry with Bearer ${REDACTED}`
    );
  });

  test('age keys, PEM blocks (also truncated) and SOPS ciphertext', () => {
    expect(
      redactText(
        'key AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ end'
      )
    ).toBe(`key ${REDACTED} end`);
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAB\n-----END OPENSSH PRIVATE KEY-----';
    expect(redactText(`before\n${pem}\nafter`)).toBe(
      `before\n${REDACTED}\nafter`
    );
    const cut = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC';
    expect(redactText(`log: ${cut}`)).toBe(`log: ${REDACTED}`);
    expect(
      redactText('data: ENC[AES256_GCM,data:abc123==,iv:xyz,tag:qqq,type:str]')
    ).toBe(`data: ${REDACTED}`);
  });

  test('credentials and secret parameters in URLs', () => {
    expect(redactText('git clone https://bot:hunter2@example.test/x.git')).toBe(
      `git clone https://${REDACTED}@example.test/x.git`
    );
    expect(
      redactText('GET https://x.test/cb?code=zzz9&state=ok&access_token=tok123')
    ).toBe(
      `GET https://x.test/cb?code=${REDACTED}&state=ok&access_token=${REDACTED}`
    );
    expect(
      redactText(
        'https://ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA@github.com/o/r'
      )
    ).not.toContain('AAAAAAAA');
  });

  test('KEY=VALUE, JSON fields, flags and cookies', () => {
    expect(redactText('FLEET_ADMIN_TOKEN=abcdef123456 PORT=8080')).toBe(
      `FLEET_ADMIN_TOKEN=${REDACTED} PORT=8080`
    );
    expect(redactText('{"password":"p@ss word","user":"bob"}')).toBe(
      `{"password":"${REDACTED}","user":"bob"}`
    );
    expect(redactText("psk: 'my wifi key'")).toBe(`psk: '${REDACTED}'`);
    expect(redactText('fleet-node --token s3cr3t-value --verbose')).toBe(
      `fleet-node --token ${REDACTED} --verbose`
    );
    expect(redactText('login --password=hunter2')).toBe(
      `login --password=${REDACTED}`
    );
    expect(redactText('Cookie: sid=abc; theme=dark\nnext')).toBe(
      `Cookie: ${REDACTED}\nnext`
    );
    expect(redactText('fleet.enroll=tok_abcdefgh1234 quiet')).toBe(
      `fleet.enroll=${REDACTED} quiet`
    );
  });

  test('64-hex secrets and hashes, labelled or not', () => {
    const hex = 'deadbeef'.repeat(8);
    expect(redactText(`node secret ${hex}`)).toBe(`node secret ${REDACTED}`);
    expect(redactText(`secretHash=${hex}`)).toBe(`secretHash=${REDACTED}`);
    expect(redactText(`{"credential":"${hex}"}`)).not.toContain('deadbeef');
  });

  test('keeps what a developer needs: git SHAs, request ids, issue codes', () => {
    const line =
      'FLEET_SECRETS_RECIPIENT_MISSING: age1qqqq is not a recipient at 9f3c2a1e5b7d4c6a8e0f1a2b3c4d5e6f70819283 (req 6f1c7a8e-1111-4222-8333-944455556666)';
    expect(redactText(line)).toBe(line);
  });

  test('an ordinary key cannot hide a secret key inside its value', () => {
    expect(redactText('https://x.test/hook?x=1#password=abc12345')).toBe(
      `https://x.test/hook?x=1#password=${REDACTED}`
    );
    expect(redactText('mode=fast token=abc123 mode2=slow')).toBe(
      `mode=fast token=${REDACTED} mode2=slow`
    );
    expect(redactText('msg="saw secret=zzz9 here"')).toBe(
      `msg="saw secret=${REDACTED} here"`
    );
  });

  test('does not redact twice or corrupt an already redacted value', () => {
    const once = redactText('token=abcdefgh');
    expect(redactText(once)).toBe(once);
  });

  test('emails are removed by default and kept only when asked', () => {
    expect(redactText('by chris@example.test today')).toBe(
      'by [redacted:email] today'
    );
    expect(redactText('by chris@example.test', { emails: false })).toBe(
      'by chris@example.test'
    );
  });

  test('configured literals are removed, including encoded forms', () => {
    const secret = 'fleet-admin-token/with+chars';
    const out = redactText(
      `a ${secret} b ${encodeURIComponent(secret)} c ${Buffer.from(secret).toString('base64')}`,
      { literals: [secret, 'x'] }
    );
    expect(out).toBe(`a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
  });

  test('aliases swap a full node id for its public form without counting', () => {
    const id = 'ab'.repeat(32);
    const redactor = createRedactor({
      aliases: new Map([[id, 'node:abababababab']]),
    });
    expect(redactor.text(`node ${id} offline`)).toBe(
      'node node:abababababab offline'
    );
    expect(redactor.summary()).toEqual([]);
  });
});

describe('looksSecret', () => {
  test('secret-looking keys in every common spelling', () => {
    for (const key of SECRET_KEYS) expect(looksSecret(key)).toBe(true);
  });
  test('ordinary keys, including ones that merely contain a secret word', () => {
    for (const key of [
      'FLEET_SECRETS_RECIPIENT_MISSING',
      'hostname',
      'secretsRecipients',
      'tokenizer',
      'passwordPolicy',
      'cookieJarSize',
      'role',
    ])
      expect(looksSecret(key)).toBe(false);
  });
});

describe('deep redaction', () => {
  test('blanks secret-named keys, scans every string, keeps booleans and structure', () => {
    const redactor = createRedactor();
    const out = redactor.deep({
      host: 'fleet-ab12',
      apiToken: 'plain-looking-value',
      nested: {
        list: ['ok', 'Bearer abcdefgh1234', { password: 12345 }],
        flag: true,
      },
      tokenHash: 'a'.repeat(64),
      credential: { rotatedAt: '2026-10-01', secretHash: 'x'.repeat(10) },
      count: 3,
      gone: undefined,
    });
    expect(out).toEqual({
      host: 'fleet-ab12',
      apiToken: REDACTED,
      nested: {
        list: ['ok', `Bearer ${REDACTED}`, { password: REDACTED }],
        flag: true,
      },
      tokenHash: REDACTED,
      credential: { rotatedAt: '2026-10-01', secretHash: REDACTED },
      count: 3,
    });
    expect(
      Object.fromEntries(redactor.summary().map((h) => [h.class, h.count]))
    ).toEqual({
      'secret-field': 4,
      bearer: 1,
    });
  });

  test('is bounded: deep nesting, huge arrays and cycles-by-depth cannot hang', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 40; i += 1) deep = { child: deep };
    const out = JSON.stringify(createRedactor().deep(deep));
    expect(out).toContain('truncated');
    const wide = createRedactor().deep(
      Array.from({ length: 5000 }, (_, i) => i)
    );
    expect((wide as unknown[]).length).toBe(400);
  });

  test('errors and dates become plain data', () => {
    const out = createRedactor().deep({
      e: new Error('boom ghp_AAAAAAAAAAAAAAAAAAAAAA'),
      d: new Date('2026-01-02T03:04:05Z'),
    });
    expect(JSON.stringify(out)).not.toContain('AAAAAAAA');
    expect(JSON.stringify(out)).toContain('2026-01-02T03:04:05.000Z');
  });
});

describe('property: a planted secret never survives', () => {
  const ITERATIONS = 200;

  test('recognisable shapes in every context, through text and deep', () => {
    const rnd = seeded(0xfeed);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const shape = SECRET_SHAPES[between(rnd, 0, SECRET_SHAPES.length - 1)]!;
      const secret = shape(rnd);
      const wrap = CONTEXTS[between(rnd, 0, CONTEXTS.length - 1)]!;
      const planted = wrap(secret.text);
      const redactor = createRedactor();
      expect(redactor.text(planted)).not.toContain(secret.core);
      const viaDeep = JSON.stringify(
        createRedactor().deep({ log: [planted], n: { msg: planted } })
      );
      expect(viaDeep).not.toContain(secret.core);
      expect(JSON.stringify(secret.core)).not.toBe('');
    }
  });

  test('opaque values behind secret-looking keys, as KEY=VALUE, JSON, YAML and flags', () => {
    const rnd = seeded(0xbeef);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const key = SECRET_KEYS[between(rnd, 0, SECRET_KEYS.length - 1)]!;
      const value = opaque(rnd);
      const forms = [
        `${key}=${value}`,
        `export ${key}="${value}"`,
        `{"${key}": "${value}", "other": 1}`,
        `${key}: ${value}`,
        `[info] set ${key}='${value}' for unit`,
        `unit env ${key}=${value} PORT=1`,
        `https://example.test/hook?x=1#${key}=${value}`,
        `a=b;c=d ${key}=${value}`,
        `msg="saw ${key}=${value} here" level=warn`,
        `{"outer":"a ${key}: ${value}"}`,
      ];
      for (const form of forms) {
        const out = redactText(form);
        expect(out).not.toContain(value);
      }
      const deep = JSON.stringify(createRedactor().deep({ [key]: value }));
      expect(deep).not.toContain(value);
    }
  });

  test('secrets nested in structured snapshots at random depth', () => {
    const rnd = seeded(0xcafe);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const secret =
        SECRET_SHAPES[between(rnd, 0, SECRET_SHAPES.length - 1)]!(rnd);
      let tree: unknown = {
        message: `failed: ${secret.text}`,
        items: [secret.text],
      };
      for (let d = between(rnd, 0, 6); d > 0; d -= 1)
        tree = rnd() < 0.5 ? { wrap: tree } : [tree, 'sibling'];
      const out = JSON.stringify(createRedactor().deep(tree));
      expect(out).not.toContain(secret.core);
    }
  });

  test('configured literals survive no context', () => {
    const rnd = seeded(0x1234);
    for (let i = 0; i < ITERATIONS; i += 1) {
      const literal = opaque(rnd) + 'Z9';
      const wrap = CONTEXTS[between(rnd, 0, CONTEXTS.length - 1)]!;
      const out = redactText(wrap(literal), { literals: [literal] });
      expect(out).not.toContain(literal);
    }
  });

  test('redaction is idempotent over random text', () => {
    const rnd = seeded(0x77);
    for (let i = 0; i < 100; i += 1) {
      const secret =
        SECRET_SHAPES[between(rnd, 0, SECRET_SHAPES.length - 1)]!(rnd);
      const once = redactText(
        CONTEXTS[between(rnd, 0, CONTEXTS.length - 1)]!(secret.text)
      );
      expect(redactText(once)).toBe(once);
    }
  });
});
