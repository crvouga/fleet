import type {
  AccessStore,
  FleetIdentity,
  LoginTransaction,
} from '../auth/browser-contract';
import type { Db } from './client';

/** All authorization data is runtime application data in the isolated fleet schema. */
export class PgAccessStore implements AccessStore {
  constructor(private readonly db: Db) {}
  async saveLogin(input: LoginTransaction): Promise<void> {
    await this
      .db`delete from fleet.login_transactions where expires_at <= now()`;
    await this.db`delete from fleet.browser_sessions where expires_at <= now()`;
    await this
      .db`insert into fleet.login_transactions (state_hash, binding_hash, verifier, nonce, next_path, expires_at) values (${input.stateHash}, ${input.bindingHash}, ${input.verifier}, ${input.nonce}, ${input.next}, ${input.expires})`;
  }
  async consumeLogin(
    stateHash: string,
    bindingHash: string
  ): Promise<LoginTransaction | null> {
    const rows = await this
      .db`delete from fleet.login_transactions where state_hash=${stateHash} and binding_hash=${bindingHash} and expires_at > now() returning *`;
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
      .db`insert into fleet.browser_sessions (token_hash, issuer, subject, email, expires_at, session_context) values (${hash}, ${identity.issuer}, ${identity.subject}, ${identity.email}, ${expires}, ${context})`;
  }
  async session(hash: string, context: string): Promise<FleetIdentity | null> {
    const rows = await this
      .db`select s.issuer, s.subject, s.email, exists(select 1 from fleet.allowed_emails a where a.email=s.email) as allowed from fleet.browser_sessions s where s.token_hash=${hash} and s.session_context=${context} and s.expires_at > now()`;
    const row = rows[0];
    return row
      ? {
          issuer: String(row['issuer']),
          subject: String(row['subject']),
          email: String(row['email']),
          allowed: row['allowed'] === true,
        }
      : null;
  }
  async deleteSession(hash: string): Promise<void> {
    await this.db`delete from fleet.browser_sessions where token_hash=${hash}`;
  }
  async emails(): Promise<readonly string[]> {
    const rows = await this
      .db`select email from fleet.allowed_emails order by email`;
    return rows.map((row: Record<string, unknown>) => String(row['email']));
  }
  async allow(email: string, actor: string): Promise<void> {
    await this.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(145226901)`;
      const rows =
        await tx`insert into fleet.allowed_emails (email, added_by) values (${email}, ${actor}) on conflict (email) do nothing returning email`;
      if (rows.length)
        await tx`insert into fleet.access_audit (email, actor, action) values (${email}, ${actor}, 'allow')`;
    });
  }
  async revoke(email: string, actor: string): Promise<boolean> {
    return this.db.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(145226901)`;
      const rows =
        await tx`delete from fleet.allowed_emails where email=${email} and (select count(*) from fleet.allowed_emails) > 1 returning email`;
      if (rows.length)
        await tx`insert into fleet.access_audit (email, actor, action) values (${email}, ${actor}, 'revoke')`;
      return rows.length > 0;
    });
  }
}
