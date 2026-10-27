import { ACTIVE_ROLES, isActiveRole, type NodeView } from '../types';
import type { NodeFacts } from '../ui/lib/facts';
export function integrationIssues(view: NodeView, facts: NodeFacts): string[] {
  const issues = [...(facts.readinessIssues ?? [])];
  if (view.approval !== 'approved')
    issues.unshift(`Fleet membership is ${view.approval}.`);
  if (view.status !== 'online')
    issues.unshift('Waiting for a current heartbeat from this node.');
  if (facts.failedUnits.length)
    issues.push(`Failed services: ${facts.failedUnits.join(', ')}`);
  if (facts.healthFailure) issues.push(facts.healthFailure);
  if (facts.paused) issues.push('Automatic synchronization is paused.');
  if (facts.rolledBack)
    issues.push('The node rolled back to its previous system.');
  // The repository no longer builds this role, so the node can never update.
  if (!isActiveRole(view.role))
    issues.push(
      `Role ${view.role} is retired in roles.json. Reinstall this machine as one of: ${ACTIVE_ROLES.join(', ')}.`
    );
  return [...new Set(issues)];
}
export function integrationReady(view: NodeView, facts: NodeFacts): boolean {
  return (
    facts.readinessIssues !== null &&
    facts.readinessIssues !== undefined &&
    view.revision !== null &&
    integrationIssues(view, facts).length === 0
  );
}
