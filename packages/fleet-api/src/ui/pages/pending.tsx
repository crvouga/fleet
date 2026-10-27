import { ActionForm } from '../components/forms';
import { Icon } from '../components/icon';
import { ChipList, RoleBadge } from '../components/status';
import { Time } from '../components/time';
import type { FleetData, FleetEntry } from '../lib/fleet-data';
import { formatMiB } from '../lib/format';

function Spec(props: { label: string; value: string }) {
  return (
    <div>
      <dt class="eyebrow">{props.label}</dt>
      <dd class="mt-0.5 break-words text-sm">{props.value}</dd>
    </div>
  );
}

function PendingSpecs(props: { entry: FleetEntry; now: Date }) {
  const { view, facts } = props.entry;
  const cpu = [
    facts.cpuCores === null ? null : `${facts.cpuCores} cores`,
    facts.cpuModel,
  ]
    .filter((part) => part !== null)
    .join(' · ');
  return (
    <dl class="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
      <Spec label="Requested role" value={view.role} />
      <Spec label="CPU" value={cpu === '' ? 'unknown' : cpu} />
      <Spec label="Memory" value={formatMiB(facts.memTotalMiB)} />
      <Spec label="Kernel" value={facts.kernel ?? 'unknown'} />
      <Spec
        label="Addresses"
        value={
          facts.addresses.length === 0
            ? (view.remoteAddr ?? 'unknown')
            : facts.addresses.join(', ')
        }
      />
      <Spec label="Enrolled via" value={view.enrolledVia} />
      <div>
        <dt class="eyebrow">First seen</dt>
        <dd class="mt-0.5 text-sm">
          <Time at={view.firstSeenAt} now={props.now} />
        </dd>
      </div>
      <div>
        <dt class="eyebrow">Capabilities</dt>
        <dd class="mt-0.5">
          <ChipList items={facts.capabilities} empty="none" />
        </dd>
      </div>
    </dl>
  );
}

function PendingCard(props: {
  entry: FleetEntry;
  now: Date;
  rejected?: boolean;
}) {
  const { view } = props.entry;
  return (
    <li class="card card-pad">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h2 class="flex flex-wrap items-center gap-2 text-base font-semibold">
            <a href={`/nodes/${view.id}`} class="text-fg">
              {view.label}
            </a>
            <RoleBadge role={view.role} />
          </h2>
          <p class="mt-0.5 font-mono text-xs text-fg-3">
            {view.hostname} #{view.shortId}
          </p>
        </div>
        <div class="flex gap-2">
          <ActionForm
            action={`/nodes/${view.id}/approve`}
            label={props.rejected === true ? 'Approve anyway' : 'Approve'}
            tone="primary"
            hidden={{ next: '/pending' }}
          />
          {props.rejected === true ? null : (
            <ActionForm
              action={`/nodes/${view.id}/reject`}
              label="Reject"
              hidden={{ next: '/pending' }}
            />
          )}
        </div>
      </div>
      <PendingSpecs entry={props.entry} now={props.now} />
    </li>
  );
}

export function PendingBody(props: { data: FleetData }) {
  const pending = props.data.entries.filter((e) => e.view.status === 'pending');
  const rejected = props.data.entries.filter(
    (e) => e.view.status === 'rejected'
  );
  return (
    <div class="space-y-6">
      {pending.length === 0 ? (
        <div class="card card-pad flex items-center gap-3 text-fg-2">
          <Icon name="check" class="size-5 text-ok" />
          <p>
            No machines are waiting for approval. New ones appear here as soon
            as they ask to join.
          </p>
        </div>
      ) : (
        <ul class="space-y-4" aria-label="Machines waiting for approval">
          {pending.map((entry) => (
            <PendingCard
              key={entry.view.id}
              entry={entry}
              now={props.data.now}
            />
          ))}
        </ul>
      )}
      {rejected.length === 0 ? null : (
        <details class="card">
          <summary class="px-4 py-3 text-sm font-medium sm:px-5">{`Rejected machines (${rejected.length})`}</summary>
          <ul
            class="space-y-4 border-t border-line p-4 sm:p-5"
            aria-label="Rejected machines"
          >
            {rejected.map((entry) => (
              <PendingCard
                key={entry.view.id}
                entry={entry}
                now={props.data.now}
                rejected
              />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
