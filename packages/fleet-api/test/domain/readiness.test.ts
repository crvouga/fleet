import { describe, expect, test } from 'bun:test';

import {
  integrationIssues,
  integrationReady,
} from '../../src/domain/readiness';
import type { NodeView, Role } from '../../src/types';
import type { NodeFacts } from '../../src/ui/lib/facts';

// Only the fields readiness reads; everything else about a node is irrelevant.
function node(role: Role): NodeView {
  return {
    role,
    approval: 'approved',
    status: 'online',
    revision: 'a'.repeat(40),
  } as NodeView;
}
const healthy = {
  readinessIssues: [],
  failedUnits: [],
  healthFailure: null,
  paused: false,
  rolledBack: false,
} as unknown as NodeFacts;

describe('readiness follows packages/fleet/roles.json', () => {
  test('an active role with nothing wrong is ready', () => {
    expect(integrationIssues(node('devbox'), healthy)).toEqual([]);
    expect(integrationReady(node('ci'), healthy)).toBe(true);
  });

  test('a node of a retired role is never ready and says how to recover', () => {
    expect(integrationIssues(node('web'), healthy)).toEqual([
      'Role web is retired in roles.json. Reinstall this machine as one of: ci, devbox.',
    ]);
    expect(integrationReady(node('netboot'), healthy)).toBe(false);
  });
});
