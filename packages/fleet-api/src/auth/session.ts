/** Expire the removed Vault-login cookie during the transition to OIDC. */
export function clearedSessionCookie(): string {
  return 'fleet_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
