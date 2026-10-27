import type { Scope } from '../../config/schema';
import type { EventRow, NodeView } from '../../types';
import { Confirm, ActionForm } from '../components/forms';
import { Chip } from '../components/status';
import {
  displayValue,
  effectiveSettings,
  scopeHref,
  scopeLabel,
} from '../lib/effective';
import type { ScopeDocuments } from '../lib/fleet-data';
import { maskUrl } from '../lib/format';
import { MAX_LABELS, MAX_NAME, MAX_NOTE } from '../lib/node-edit';
import { settingMeta } from '../lib/setting-meta';
import { cx } from '../lib/tw';
import { EventList } from './overview';

function LabelsField(props: { view: NodeView }) {
  const { view } = props;
  return (
    <div>
      <label class="label" for="edit-labels">
        Labels
      </label>
      <textarea
        id="edit-labels"
        name="labels"
        rows={3}
        class="field font-mono text-xs"
        aria-describedby="edit-labels-help"
      >
        {view.labels.join('\n')}
      </textarea>
      <p id="edit-labels-help" class="help">
        One per line, up to {MAX_LABELS}. Letters, digits, dot, dash, colon and
        underscore.
      </p>
    </div>
  );
}

/** Edit display name, note and labels. A plain POST form. */
export function EditPanel(props: { view: NodeView }) {
  const { view } = props;
  return (
    <section class="card card-pad" aria-labelledby="edit-title">
      <h2 id="edit-title" class="text-sm font-semibold">
        Name, note and labels
      </h2>
      <form
        method="post"
        action={`/nodes/${view.id}/edit`}
        class="mt-3 space-y-4"
      >
        <div>
          <label class="label" for="edit-name">
            Display name
          </label>
          <input
            id="edit-name"
            name="displayName"
            class="field"
            maxlength={MAX_NAME}
            value={view.displayName ?? ''}
            placeholder={view.hostname}
            aria-describedby="edit-name-help"
          />
          <p id="edit-name-help" class="help">
            Shown instead of the hostname. Leave empty to use {view.hostname}.
          </p>
        </div>
        <div>
          <label class="label" for="edit-note">
            Note
          </label>
          <textarea
            id="edit-note"
            name="note"
            rows={3}
            maxlength={MAX_NOTE}
            class="field"
            aria-describedby="edit-note-help"
          >
            {view.note ?? ''}
          </textarea>
          <p id="edit-note-help" class="help">
            Anything worth remembering, such as where the machine lives.
          </p>
        </div>
        <LabelsField view={view} />
        <button type="submit" class="btn btn-primary">
          Save changes
        </button>
      </form>
    </section>
  );
}

function SourceBadge(props: { source: Scope | null }) {
  if (props.source === null) {
    return (
      <span class="rounded bg-muted px-1.5 py-0.5 text-xs text-fg-3">
        default
      </span>
    );
  }
  const tone =
    props.source === 'fleet'
      ? 'bg-muted text-fg-2'
      : props.source.startsWith('role:')
        ? 'bg-accent-soft text-accent-ink'
        : 'bg-warn-soft text-warn';
  return (
    <a
      href={scopeHref(props.source)}
      class={cx(
        'rounded px-1.5 py-0.5 text-xs font-medium no-underline hover:underline',
        tone
      )}
      title={`Set at ${scopeLabel(props.source).toLowerCase()}`}
    >
      {scopeLabel(props.source)}
    </a>
  );
}

function valueText(path: string, value: unknown): string {
  return path === 'alerts.webhookUrl' && typeof value === 'string'
    ? maskUrl(value)
    : displayValue(value);
}

/** Every setting that applies to this node and where each value comes from. */
export function EffectiveConfig(props: {
  view: NodeView;
  documents: ScopeDocuments;
}) {
  const rows = effectiveSettings(props.view, props.documents);
  return (
    <section class="card" aria-labelledby="config-title">
      <div class="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 id="config-title" class="text-sm font-semibold">
          Effective configuration
        </h2>
        <a class="text-xs" href={`/settings/node:${props.view.id}`}>
          Override for this node
        </a>
      </div>
      <dl class="divide-y divide-line">
        {rows.map((row) => (
          <div
            key={row.path}
            class="flex items-start justify-between gap-3 px-4 py-2"
          >
            <dt class="text-sm text-fg-2">
              {settingMeta(row.section, row.key).label}
            </dt>
            <dd class="flex flex-wrap items-center justify-end gap-1.5 text-right">
              <span
                class={cx(
                  'tabular break-all text-sm',
                  row.source === null && 'text-fg-3'
                )}
              >
                {valueText(row.path, row.value)}
              </span>
              <SourceBadge source={row.source} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Approve, reject, retire and delete, the last two behind a confirmation. */
export function ManagePanel(props: { view: NodeView }) {
  const { view } = props;
  const base = `/nodes/${view.id}`;
  return (
    <section
      class="card card-pad space-y-3"
      aria-labelledby="manage-title"
      id="manage"
    >
      <h2 id="manage-title" class="text-sm font-semibold">
        Manage
      </h2>
      {view.approval === 'pending' || view.approval === 'rejected' ? (
        <div class="flex flex-wrap gap-2">
          <ActionForm
            action={`${base}/approve`}
            label={view.approval === 'rejected' ? 'Approve anyway' : 'Approve'}
            tone="primary"
          />
          {view.approval === 'pending' ? (
            <ActionForm action={`${base}/reject`} label="Reject" />
          ) : null}
        </div>
      ) : null}
      {view.approval === 'approved' ? (
        <Confirm
          id="retire"
          summary="Retire this node"
          button="Retire node"
          action={`${base}/retire`}
          warning="Retiring stops offline notices for this machine and ends its access. It becomes pending again if it registers again."
        />
      ) : null}
      <Confirm
        id="delete"
        summary="Delete this node"
        button="Delete node and history"
        action={`${base}/delete`}
        warning="Deleting forgets the node and all of its heartbeat history. Events keep its name. This cannot be undone."
      />
    </section>
  );
}

export function NodeTimeline(props: {
  events: readonly EventRow[];
  now: Date;
}) {
  return (
    <section class="card" aria-labelledby="timeline-title">
      <div class="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
        <h2 id="timeline-title" class="text-sm font-semibold">
          Timeline
        </h2>
        <Chip text={`${props.events.length} recent`} />
      </div>
      {props.events.length === 0 ? (
        <p class="px-4 py-6 text-fg-2 sm:px-5">
          Nothing has happened to this node yet.
        </p>
      ) : (
        <EventList events={props.events} now={props.now} />
      )}
    </section>
  );
}
