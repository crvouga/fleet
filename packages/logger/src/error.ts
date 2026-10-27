const SQL_REASONS: Record<string, string> = {
  '53300': 'database_connection_exhausted',
  '42501': 'database_permission_denied',
  '42P01': 'database_table_missing',
  '42703': 'database_column_missing',
  '28P01': 'database_authentication_failed',
  '3F000': 'database_schema_missing',
  '57014': 'database_query_cancelled',
  '23505': 'database_unique_conflict',
  '40P01': 'database_deadlock',
};
const OAUTH_ERRORS = new Set([
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'access_denied',
  'invalid_token',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
  'login_required',
  'interaction_required',
]);
const KNOWN_MESSAGES: Record<string, string> = {
  '__Host- Cookie must have Secure attributes':
    'cookie_secure_attribute_missing',
  '__Secure- Cookie must have Secure attributes':
    'cookie_secure_attribute_missing',
  'Unexpected OIDC destination': 'unexpected_oidc_destination',
  'Registration ownership mismatch': 'registration_ownership_mismatch',
};

function code(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
    ? value
    : undefined;
}

function frames(error: Error): string[] {
  return (error.stack ?? '')
    .split('\n')
    .filter(
      (line) =>
        /^\s+at /.test(line) && !line.includes('://') && !line.includes('?')
    )
    .slice(0, 6);
}

function databaseState(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9A-Z]{5}$/.test(value)
    ? value
    : undefined;
}

/** Do not serialize error messages, SQL/detail, HTTP bodies or token claims. */
export function errorDetails(
  error: unknown,
  depth = 0
): Record<string, unknown> {
  if (!error || typeof error !== 'object' || depth >= 5)
    return { type: 'UnknownError' };
  const fields = error as Error & Record<string, unknown>;
  const sqlstate = databaseState(fields['errno']);
  const oauth = oauthError(fields['error']);
  return {
    type: code(fields.name) ?? 'Error',
    code: code(fields['code']),
    sqlstate,
    oauth,
    reason: reason(fields, sqlstate),
    operation: code(fields['operation']),
    status: typeof fields['status'] === 'number' ? fields['status'] : undefined,
    setting: setting(fields['setting']),
    frames: error instanceof Error ? frames(error) : [],
    ...(fields.cause ? { cause: errorDetails(fields.cause, depth + 1) } : {}),
  };
}

function reason(fields: Error & Record<string, unknown>, sqlstate?: string) {
  return sqlstate ? SQL_REASONS[sqlstate] : KNOWN_MESSAGES[fields.message];
}

function setting(value: unknown): string | undefined {
  return typeof value === 'string' && /^AUTH_[A-Z_]+$/.test(value)
    ? value
    : undefined;
}

export function oauthError(value: unknown): string | undefined {
  return typeof value === 'string' && OAUTH_ERRORS.has(value)
    ? value
    : undefined;
}
