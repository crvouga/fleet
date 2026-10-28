import type {
  AccessStore,
  FleetIdentity,
  LoginTransaction,
} from '../auth/browser-contract';
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
    identity: Omit<FleetIdentity, 'allowed'>,
    expires: Date,
    context: string
  ): Promise<void> {
    await this
      .db`insert into browser_sessions (token_hash, issuer, subject, email, expires_at, session_context) values (${hash}, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${expires}, ${context})`;
  }
  async session(hash: string, context: string): Promise<FleetIdentity | null> {
    const rows = await this
      .db`select s.issuer, s.subject, s.email, exists(select 1 from allowed_emails a where a.email=s.email) as allowed from browser_sessions s where s.token_hash=${hash} and s.session_context=${context} and s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
    const row = rows[0];
    return row
      ? {
          issuer: String(row['issuer']),
          subject: String(row['subject']),
          email: String(row['email']),
          allowed: row['allowed'] === 1,
        }
      : null;
  }
  async deleteSession(hash: string): Promise<void> {
    await this.db`delete from browser_sessions where token_hash=${hash}`;
  }
  async emails(): Promise<readonly string[]> {
    const rows = await this.db`select email from allowed_emails order by email`;
    return rows.map((row: Record<string, unknown>) => String(row['email']));
  }
  async allow(email: string, actor: string): Promise<void> {
    await this.db.begin(async (tx) => {
      const rows =
        await tx`insert into allowed_emails (email, added_by) values (${email}, ${actor}) on conflict (email) do nothing returning email`;
      if (rows.length)
        await tx`insert into access_audit (email, actor, action) values (${email}, ${actor}, 'allow')`;
    });
  }
  async revoke(email: string, actor: string): Promise<boolean> {
    return this.db.begin(async (tx) => {
      const rows =
        await tx`delete from allowed_emails where email=${email} and (select count(*) from allowed_emails) > 1 returning email`;
      if (rows.length)
        await tx`insert into access_audit (email, actor, action) values (${email}, ${actor}, 'revoke')`;
      return rows.length > 0;
    });
  }
}
