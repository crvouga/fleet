import type { BindingKey } from './binding';
import type { GrantRow, NewGrant } from './grants';

/**
 * What presenting a grant token for a node did. `redeemed` is the one first
 * use; `resumed` the bound node trying again; `reused` any other node.
 */
export type Redemption =
  | {
      readonly outcome: 'redeemed' | 'resumed' | 'reused';
      readonly grant: GrantRow;
    }
  | {
      readonly outcome: 'expired' | 'revoked';
      readonly grant: GrantRow;
    }
  | { readonly outcome: 'unknown' };

export type RevokeResult =
  | { readonly ok: true; readonly grant: GrantRow; readonly changed: boolean }
  | { readonly ok: false };

/** Enrollment grants and the controller secret that signs installer bindings. */
export interface GrantStore {
  create(grant: NewGrant): Promise<GrantRow>;
  /** Newest first. */
  list(limit: number): Promise<readonly GrantRow[]>;
  find(id: string): Promise<GrantRow | null>;
  /** Read-only lookup for the check endpoint. */
  findByHash(tokenHash: string): Promise<GrantRow | null>;
  /**
   * Atomically binds the grant to `nodeId` on first use. Of any number of
   * concurrent presentations by different nodes exactly one is `redeemed`.
   */
  redeem(tokenHash: string, nodeId: string, now: Date): Promise<Redemption>;
  /** Undoes a `redeemed` whose registration then failed, so the grant is not lost. */
  release(id: string, nodeId: string): Promise<void>;
  /** Idempotent. A used grant can be revoked; that does not un-approve its node. */
  revoke(id: string, now: Date): Promise<RevokeResult>;
  /** The signing secret, created randomly on first use and kept in `controller_secrets`. */
  bindingKey(): Promise<BindingKey>;
}
