import type {
  SettingsImpact,
  SettingsIssue,
} from '../../domain/settings-impact';

/** Everything the safety layer adds to a settings page: concurrency, impact, acknowledgement. */
export interface SettingsSafety {
  /** The revision the form was loaded at; sent back so a concurrent change is caught. */
  readonly revision: number;
  /** Set after a refused save: someone else saved first. */
  readonly conflict: { readonly current: number } | null;
  /** Blocking issues the person must tick before the save goes through. */
  readonly issues: readonly SettingsIssue[];
  readonly acknowledged: readonly string[];
  /** The result of "Preview impact". */
  readonly preview: SettingsImpact | null;
  /** A viewer sees the page but cannot change it. */
  readonly readOnly: boolean;
}

export const NO_SAFETY: SettingsSafety = {
  revision: 0,
  conflict: null,
  issues: [],
  acknowledged: [],
  preview: null,
  readOnly: false,
};

export function PreconditionFields(props: { safety: SettingsSafety }) {
  return (
    <input
      type="hidden"
      name="expectedRevision"
      value={String(props.safety.revision)}
    />
  );
}

export function ConflictBanner(props: {
  scope: string;
  safety: SettingsSafety;
}) {
  const { conflict } = props.safety;
  if (conflict === null) return null;
  return (
    <div
      role="alert"
      class="mb-5 rounded-lg border border-bad-dot/40 bg-bad-soft px-4 py-3 text-sm text-bad"
    >
      <p class="font-semibold">Nothing was saved: these settings changed.</p>
      <p>
        Someone saved {props.scope} (now revision {conflict.current}) after you
        opened this page, and saving would have overwritten their change. Your
        edits are kept in the advanced raw JSON editor below. Load the latest
        version, review it, then apply your edits again.
      </p>
      <p class="mt-2">
        <a class="btn btn-sm" href={`/settings/${props.scope}`}>
          Discard my edits and load the latest
        </a>
      </p>
    </div>
  );
}

export function WarningsPanel(props: { safety: SettingsSafety }) {
  const { issues, acknowledged } = props.safety;
  if (issues.length === 0) return null;
  return (
    <div
      role="alert"
      class="mb-5 rounded-lg border border-warn-dot/40 bg-warn-soft px-4 py-3 text-sm"
    >
      <p class="font-semibold">
        This change could destabilise the fleet. It was not saved.
      </p>
      <ul class="mt-2 space-y-2">
        {issues.map((issue) => (
          <li key={issue.code}>
            <label class="flex items-start gap-2">
              <input
                type="checkbox"
                name="acknowledge"
                value={issue.code}
                checked={acknowledged.includes(issue.code)}
              />
              <span>
                <span class="font-medium">I understand: </span>
                {issue.message}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <p class="mt-2 text-fg-2">Tick every box to confirm, then save again.</p>
    </div>
  );
}

export function ImpactPanel(props: { impact: SettingsImpact | null }) {
  const { impact } = props;
  if (impact === null) return null;
  return (
    <section
      class="card card-pad mb-5 space-y-2"
      aria-labelledby="impact-title"
      role="status"
    >
      <h2 id="impact-title" class="text-sm font-semibold">
        Preview: nothing was saved
      </h2>
      <p class="text-sm">
        {impact.changes.length === 0
          ? 'No node would receive a different desired document.'
          : `${impact.changes.length} of ${impact.totalNodes} nodes would receive a new desired document on their next heartbeat.`}
      </p>
      {impact.changes.length > 0 ? (
        <ul class="list-disc pl-5 text-sm text-fg-2">
          {impact.changes.slice(0, 20).map((change) => (
            <li key={change.nodeId}>
              {change.label}{' '}
              <code class="font-mono text-xs">
                {change.before.revision} to {change.after.revision}
              </code>
            </li>
          ))}
        </ul>
      ) : null}
      {impact.issues.length > 0 ? (
        <ul class="list-disc pl-5 text-sm">
          {impact.issues.map((issue) => (
            <li key={issue.code}>
              {issue.blocking ? 'Needs acknowledgement: ' : ''}
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
