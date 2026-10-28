import { createHash } from 'node:crypto';

import type { IssueKind } from './types';

const MAX_NORMALIZED = 300;
const FINGERPRINT_CHARS = 32;

/** The marker that ties a GitHub issue to its fingerprint, searched before every create. */
export const MARKER_PREFIX = 'fleet-issue-fingerprint:';

export function markerFor(fingerprint: string): string {
  return `<!-- ${MARKER_PREFIX}${fingerprint} -->`;
}

/** The fingerprint a body carries, or null. */
export function fingerprintIn(body: string): string | null {
  const match = new RegExp(
    `<!-- ${MARKER_PREFIX}([0-9a-f]{${FINGERPRINT_CHARS}}) -->`
  ).exec(body);
  return match?.[1] ?? null;
}

const STRIPS: readonly (readonly [RegExp, string])[] = [
  [/\bage1[0-9a-z]{10,}\b/g, '<age>'],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<id>',
  ],
  [
    /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g,
    '<ts>',
  ],
  [/\b\d{1,2}:\d{2}:\d{2}\b/g, '<ts>'],
  [/https?:\/\/[^\s"'<>)]+/gi, '<url>'],
  [/(?:\/[\w.@+-]+){2,}\/?/g, '<path>'],
  [/\bfleet-[0-9a-f]{4}\b/gi, '<host>'],
  [/\b(?:0x)?[0-9a-f]{7,}\b/gi, '<hex>'],
  [/\b\d+(?:\.\d+)?\b/g, '<n>'],
  [/\s+/g, ' '],
];

/**
 * A message with everything that varies between two occurrences of one failure
 * removed: ids, timestamps, paths, URLs, hex digests and numbers.
 */
export function normalizeMessage(message: string): string {
  let out = message;
  for (const [pattern, replacement] of STRIPS)
    out = out.replace(pattern, replacement);
  return out.trim().toLowerCase().slice(0, MAX_NORMALIZED);
}

export interface FingerprintInput {
  readonly kind: IssueKind;
  readonly classification: string;
  readonly message: string;
  readonly role: string | null;
  readonly closure: string | null;
  readonly component: string;
}

/** A stable identity for "the same failure": kind, class, normalized message, role/closure, component. */
export function fingerprintOf(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.kind,
    input.classification,
    normalizeMessage(input.message),
    input.role ?? '',
    input.closure ?? '',
    input.component,
  ]);
  return createHash('sha256')
    .update(canonical)
    .digest('hex')
    .slice(0, FINGERPRINT_CHARS);
}
