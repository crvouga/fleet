import type { RelayConfig } from './browser-contract';
import type { EnvSource } from '../env';

function validIssuer(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}
function validOrigin(url: URL): boolean {
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname))
  );
}
export function readRelay(
  source: EnvSource,
  problems: string[]
): RelayConfig | undefined {
  const keys = [
    'FLEET_OIDC_ISSUER',
    'FLEET_OIDC_CLIENT_ID',
    'FLEET_PUBLIC_ORIGIN',
  ] as const;
  if (!keys.some((key) => source[key]?.trim())) return undefined;
  const missing = keys.filter((key) => !source[key]?.trim());
  for (const key of missing)
    problems.push(`${key} is required for OIDC sign-in`);
  if (missing.length) return undefined;
  try {
    const issuer = new URL(source['FLEET_OIDC_ISSUER']!);
    const origin = new URL(source['FLEET_PUBLIC_ORIGIN']!);
    if (
      !validIssuer(issuer) ||
      !validOrigin(origin) ||
      origin.origin !== source['FLEET_PUBLIC_ORIGIN']
    )
      throw new Error();
    return {
      issuer: issuer.href,
      origin: origin.origin,
      clientId: source['FLEET_OIDC_CLIENT_ID']!.trim(),
    };
  } catch {
    problems.push(
      'FLEET_OIDC_ISSUER must identify an HTTPS OIDC issuer; FLEET_PUBLIC_ORIGIN must be an HTTPS or loopback HTTP origin'
    );
    return undefined;
  }
}
