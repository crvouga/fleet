import type { Hono } from 'hono';

import type { AppDeps } from '../deps';

import { mountAdminCredentials } from './admin-credentials';
import { mountDesiredHistory } from './admin-desired-history';

/** Credential rotation and revocation, and the per-node desired-document history. */
export function mountAccessSafety(app: Hono, deps: AppDeps): void {
  mountAdminCredentials(app, deps);
  mountDesiredHistory(app, deps);
}
