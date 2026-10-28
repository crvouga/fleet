/** Clear the legacy cookie; injected browser auth owns current sessions. */
export function clearedSessionCookie(): string {
  return 'fleet_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
