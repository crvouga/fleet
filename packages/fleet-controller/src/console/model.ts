import type { FleetConfig } from '../config/fields';
import type { FleetData } from '../ui/lib/fleet-data';
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
  access: { available: boolean; emails: string[] };
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
