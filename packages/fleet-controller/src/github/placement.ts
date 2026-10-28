import { createHash } from 'node:crypto';

import type { GithubPolicy } from './types';

/** A node as placement sees it: what it can serve and how many slots it has. */
export interface PlacementNode {
  readonly id: string;
  /** Hardware capabilities and the operator's node labels (gpu, high-mem...). */
  readonly capabilities: readonly string[];
  /** Reported runner slots; null until the node reported them. */
  readonly slots: number | null;
}

export interface PlacementPlan {
  /** Per node, the repositories it serves, in the order its slots take them. */
  readonly byNode: ReadonlyMap<string, readonly string[]>;
  /** Repositories no eligible node can serve (missing capability or no free slot). */
  readonly unplaced: readonly string[];
}

function rank(left: string, right: string): string {
  return createHash('sha256').update(`${left}\u0000${right}`).digest('hex');
}

function serves(node: PlacementNode, needs: readonly string[]): boolean {
  return needs.every((need) => node.capabilities.includes(need));
}

const UNKNOWN_SLOTS = 64;

interface Board {
  readonly nodes: readonly PlacementNode[];
  readonly taken: Map<string, string[]>;
}

function best(
  board: Board,
  repository: string,
  needs: readonly string[]
): PlacementNode | undefined {
  return board.nodes
    .filter((node) => serves(node, needs))
    .filter((node) => !board.taken.get(node.id)?.includes(repository))
    .filter(
      (node) =>
        (board.taken.get(node.id)?.length ?? 0) < (node.slots ?? UNKNOWN_SLOTS)
    )
    .sort((a, b) =>
      rank(repository, b.id).localeCompare(rank(repository, a.id))
    )[0];
}

/**
 * Deterministic, stable placement by rendezvous hashing: each repository ranks
 * the nodes by sha256(repository, node) and the best ones take it, so adding or
 * removing a node moves only the repositories that node wins or loses. A node's
 * own order (which repository its slot 1 serves) is also by hash, so the
 * fleet's first slots do not all pile onto the same repository. Capacity is
 * respected and shared fairly: placement runs in rounds, every repository
 * getting its first node before any gets a second, and a node never takes more
 * repositories than it has slots.
 */
export function planPlacement(
  repositories: readonly string[],
  policy: GithubPolicy,
  nodes: readonly PlacementNode[]
): PlacementPlan {
  const board: Board = {
    nodes,
    taken: new Map(nodes.map((n) => [n.id, []])),
  };
  const sorted = [...repositories].sort();
  const want =
    policy.maxNodesPerRepository > 0
      ? policy.maxNodesPerRepository
      : nodes.length;
  const placed = new Set<string>();
  for (let round = 1; round <= want; round += 1) {
    for (const repository of sorted) {
      const needs = policy.repositoryRequirements[repository] ?? [];
      const node = best(board, repository, needs);
      if (node === undefined) continue;
      board.taken.get(node.id)?.push(repository);
      placed.add(repository);
    }
  }
  const byNode = new Map<string, readonly string[]>();
  for (const [id, list] of board.taken) {
    byNode.set(
      id,
      [...list].sort((a, b) => rank(id, a).localeCompare(rank(id, b)))
    );
  }
  return { byNode, unplaced: sorted.filter((r) => !placed.has(r)) };
}
