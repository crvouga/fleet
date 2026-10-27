import { errorDetails } from './error';

const SENSITIVE =
  /password|secret|authorization|cookie|credential|access.?token|refresh.?token|id.?token|verifier|nonce|binding|claims|^headers$|^body$|^query$|^email$|^subject$/i;

function text(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s"<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        return `${url.protocol}//${url.host}${url.pathname}${url.search || url.hash ? '?[REDACTED]' : ''}`;
      } catch {
        return '[REDACTED_URL]';
      }
    });
}

/** Bound size/depth, handle cycles and Error objects, redact common secret fields. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (value instanceof Error) return redact(errorDetails(value), depth + 1);
  if (typeof value === 'string') return text(value).slice(0, 4000);
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 80)
      .map(([key, item]) => [
        key,
        SENSITIVE.test(key) ? '[REDACTED]' : redact(item, depth + 1),
      ])
  );
}
