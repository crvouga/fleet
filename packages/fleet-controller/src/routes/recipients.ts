import { ACTIVE_ROLES, ROLES, type NodeRow, type Role } from '../types';

export interface Recipient {
  readonly nodeId: string;
  readonly hostname: string;
  readonly recipient: string;
}

/**
 * `GET /v1/recipients`: the age recipients the operator encrypts each role's
 * secrets to. Only approved nodes with an assigned role and a reported
 * recipient; unassigned nodes are excluded. Every active role is listed, even
 * when empty, plus any retired role that still has nodes. Sorted by hostname.
 */
export function recipientsOf(nodes: readonly NodeRow[]): {
  roles: Partial<Record<Role, Recipient[]>>;
} {
  const roles: Partial<Record<Role, Recipient[]>> = {};
  for (const role of ROLES) {
    const list = nodes
      .filter(
        (node) =>
          node.approval === 'approved' &&
          node.role === role &&
          node.ageRecipient !== null
      )
      .map((node) => ({
        nodeId: node.id,
        hostname: node.hostname,
        recipient: node.ageRecipient ?? '',
      }))
      .sort(
        (a, b) =>
          a.hostname.localeCompare(b.hostname) ||
          a.nodeId.localeCompare(b.nodeId)
      );
    if (list.length > 0 || (ACTIVE_ROLES as readonly Role[]).includes(role))
      roles[role] = list;
  }
  return { roles };
}
