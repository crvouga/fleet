import type {
  AccessEntry,
  AccessStore,
  FleetIdentity,
  LoginTransaction,
  RoleChange,
} from '../auth/browser-contract';
import { isAccessRole, type AccessRole } from '../auth/roles';
import { insertAudit } from './audit-queries';
import type { Db } from './client';

/** All authorization data is runtime application data in the application database. */
export class SqliteAccessStore implements AccessStore {
  constructor(private readonly db: Db) {}
  async saveLogin(input: LoginTransaction): Promise<void> {
    await this
      .db`delete from login_transactions where expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    await this
      .db`delete from browser_sessions where expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    await this
      .db`insert into login_transactions (state_hash, binding_hash, verifier, nonce, next_path, expires_at) values (${input.stateHash}, ${input.bindingHash}, ${input.verifier}, ${input.nonce}, ${input.next}, ${input.expires})`;
  }
  async consumeLogin(
    stateHash: string,
    bindingHash: string
  ): Promise<LoginTransaction | null> {
    const rows = await this
      .db`delete from login_transactions where state_hash=${stateHash} and binding_hash=${bindingHash} and expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') returning *`;
    const row = rows[0];
    return row
      ? {
          stateHash,
          bindingHash,
          verifier: String(row['verifier']),
          nonce: String(row['nonce']),
          next: String(row['next_path']),
          expires: new Date(String(row['expires_at'])),
        }
      : null;
  }
  async createSession(
    hash: string,
    identity: Omit<FleetIdentity, 'allowed' | 'role'>,
    expires: Date,
    context: string
  ): Promise<void> {
    await this
      .db`insert into browser_sessions (token_hash, issuer, subject, email, expires_at, session_context) values (${hash}, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${expires}, ${context})`;
  }
  async session(hash: string, context: string): Promise<FleetIdentity | null> {
    const rows = await this
      .db`select s.issuer, s.subject, s.email, a.role as role from browser_sessions s left join allowed_emails a on a.email=s.email where s.token_hash=${hash} and s.session_context=${context} and s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    const row = rows[0];
    if (!row) return null;
    const stored = row['role'];
    return {
      issuer: String(row['issuer']),
      subject: String(row['subject']),
      email: String(row['email']),
      allowed: stored !== null && stored !== undefined,
      // Fail closed: an unknown stored value is a viewer.
      role: isAccessRole(stored) ? stored : 'viewer',
    };
  }
  async deleteSession(hash: string): Promise<void> {
    await this.db`delete from browser_sessions where token_hash=${hash}`;
  }
  async emails(): Promise<readonly string[]> {
    const rows = await this.db`select email from allowed_emails order by email`;
    return rows.map((row: Record<string, unknown>) => String(row['email']));
  }
  async entries(): Promise<readonly AccessEntry[]> {
    const rows = await this
      .db`select email, role, added_by, added_at from allowed_emails order by email`;
    return rows.map((row: Record<string, unknown>) => ({
      email: String(row['email']),
      role: isAccessRole(row['role']) ? row['role'] : 'viewer',
      addedBy: String(row['added_by']),
      addedAt: new Date(String(row['added_at'])),
    }));
  }
  async allow(
    email: string,
    actor: string,
    role: AccessRole = 'admin'
  ): Promise<void> {
    await this.db.begin(async (tx) => {
      const rows =
        await tx`insert into allowed_emails (email, added_by, role) values (${email}, ${actor}, ${role}) on conflict (email) do nothing returning email`;
      if (!rows.length) return;
      await tx`insert into access_audit (email, actor, action) values (${email}, ${actor}, 'allow')`;
      await insertAudit(tx, {
        actor,
        action: 'access.allow',
        targetKind: 'access',
        targetId: email,
        detail: { role },
      });
    });
  }
  async revoke(email: string, actor: string): Promise<boolean> {
    return this.db.begin(async (tx) => {
      const rows =
        await tx`delete from allowed_emails where email=${email} and not (role='admin' and (select count(*) from allowed_emails where role='admin') <= 1) returning email, role`;
      if (rows.length) {
        await tx`insert into access_audit (email, actor, action) values (${email}, ${actor}, 'revoke')`;
        await insertAudit(tx, {
          actor,
          action: 'access.revoke',
          targetKind: 'access',
          targetId: email,
          detail: { role: String(rows[0]?.['role'] ?? '') },
        });
      }
      return rows.length > 0;
    });
  }
  async setRole(
    email: string,
    role: AccessRole,
    actor: string
  ): Promise<RoleChange> {
    return this.db.begin(async (tx) => {
      const found =
        await tx`select role from allowed_emails where email=${email}`;
      const previous = found[0]?.['role'];
      if (previous === undefined) return 'missing';
      if (previous === role) return 'unchanged';
      const rows =
        await tx`update allowed_emails set role=${role} where email=${email} and not (role='admin' and ${role}<>'admin' and (select count(*) from allowed_emails where role='admin') <= 1) returning email`;
      if (!rows.length) return 'last_admin';
      await tx`insert into access_audit (email, actor, action) values (${email}, ${actor}, ${`role:${role}`})`;
      await insertAudit(tx, {
        actor,
        action: 'access.role',
        targetKind: 'access',
        targetId: email,
        detail: { from: String(previous), to: role },
      });
      return 'changed';
    });
  }
}
