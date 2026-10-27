import { sha256Hex } from './hash';

export const NODE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const NODE_SECRET_PATTERN = /^[0-9a-f]{64}$/;

export interface NodeCredential {
  readonly nodeId: string;
  /** sha256 of the presented secret: the only form that is ever compared or stored. */
  readonly secretHash: string;
}

/** Parses `Authorization: Bearer <id>.<secret>`. Null when absent or malformed. */
export function parseNodeCredential(
  header: string | undefined
): NodeCredential | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const nodeId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!NODE_ID_PATTERN.test(nodeId) || !NODE_SECRET_PATTERN.test(secret)) {
    return null;
  }
  return { nodeId, secretHash: sha256Hex(secret) };
}
