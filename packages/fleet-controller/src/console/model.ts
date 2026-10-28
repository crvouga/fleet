import type { FleetConfig } from '../config/fields';
import type { FleetData } from '../ui/lib/fleet-data';
import type { AccessRole } from '../auth/roles';
import type { CredentialStatus } from '../domain/credential-rotation';
import type { AnnotatedDesiredRow } from '../domain/desired-history';
import type { EventRow, HeartbeatPoint, SettingsHistoryRow } from '../types';
export interface ConsoleState {
  path: string;
  status: 'ready' | 'signed-out' | 'denied';
  actor: string | null;
  authAvailable?: boolean;
  next?: string;
  error?: string | null;
  fleet: FleetData;
  events: EventRow[];
  nextBefore: number | null;
  points: HeartbeatPoint[];
  history: SettingsHistoryRow[];
  /** The signed-in person's role; a viewer sees controls disabled. */
  role?: AccessRole;
  /** The settings revision of every scope that was ever written; absent means 0. */
  revisions?: Record<string, number>;
  /** Node pages: the desired-document history (newest first) and the credential state. */
  desiredHistory?: AnnotatedDesiredRow[];
  credential?: CredentialStatus | null;
  access: {
    available: boolean;
    emails: string[];
    entries?: { email: string; role: AccessRole }[];
  };
}
const dateKeys = new Set([
  'now',
  'at',
  'firstSeenAt',
  'lastSeenAt',
  'approvedAt',
  'retiredAt',
  'offlineNotifiedAt',
  'updatedAt',
  'changedAt',
  'rotateRequestedAt',
  'rotatedAt',
  'revokedAt',
]);
export function decodeState(text: string): ConsoleState {
  const state = JSON.parse(text, (key, value: unknown) =>
    dateKeys.has(key) && typeof value === 'string' ? new Date(value) : value
  ) as ConsoleState;
  if (state.status === 'ready')
    state.fleet = {
      ...state.fleet,
      documents: new Map(
        state.fleet.documents as unknown as [string, FleetConfig][]
      ),
    };
  return state;
}
export function messageOf(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'Request failed. Please try again.';
}
