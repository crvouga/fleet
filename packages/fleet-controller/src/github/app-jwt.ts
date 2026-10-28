import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 540;

/**
 * Parses an RSA private key in PEM form (PKCS#1 or PKCS#8). The error never
 * includes the key or the parser's message, which can quote key bytes.
 */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error('not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
  return key;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** An RS256 GitHub App JWT: valid for nine minutes, backdated a minute for clock skew. */
export function signAppJwt(appId: string, key: KeyObject, now: Date): string {
  const issued = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({
      iat: issued - JWT_BACKDATE_SECONDS,
      exp: issued + JWT_LIFETIME_SECONDS,
      iss: appId,
    })
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${base64url(signer.sign(key))}`;
}
