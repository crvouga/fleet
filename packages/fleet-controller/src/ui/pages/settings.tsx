import {
  RULES,
  SECTIONS,
  type FleetConfig,
  type Scope,
} from '../../config/schema';
import {
  ROLES,
  isActiveRole,
  type NodeView,
  type SettingsHistoryRow,
} from '../../types';
import { Icon } from '../components/icon';
import { Time } from '../components/time';
import { inheritedSettings, scopeLabel } from '../lib/effective';
import type { ScopeDocuments } from '../lib/fleet-data';
import { rawJson, splitErrors, type Draft } from '../lib/settings-form';
import { SECTION_META } from '../lib/setting-meta';
import { cx } from '../lib/tw';
import { SettingField } from './settings-fields';

export interface SettingsPageProps {
  readonly scope: Scope;
  readonly node: NodeView | null;
  readonly stored: FleetConfig;
  readonly draft: Draft;
  readonly errors: readonly string[];
  readonly rawError: string | null;
  readonly rawText: string | null;
  readonly history: readonly SettingsHistoryRow[];
  readonly documents: ScopeDocuments;
  readonly now: Date;
}

function countKeys(config: FleetConfig | undefined): number {
  if (config === undefined) return 0;
  return Object.values(config).reduce(
    (sum: number, entries) => sum + Object.keys(entries as object).length,
    0
  );
}

function ScopeTab(props: {
  href: string;
  label: string;
  current: boolean;
  count: number;
}) {
  return (
    <a
      href={props.href}
      aria-current={props.current ? 'page' : undefined}
      class={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium no-underline',
        props.current
          ? 'bg-accent-soft text-accent-ink'
          : 'text-fg-2 hover:bg-muted hover:text-fg'
      )}
    >
      {props.label}
      {props.count > 0 ? (
        <span
          class="tabular rounded-full bg-muted px-1.5 text-xs text-fg-2"
          title={`${props.count} overridden`}
        >
          {props.count}
          <span class="sr-only"> settings set</span>
        </span>
      ) : null}
    </a>
  );
}

function ScopeSwitcher(props: {
  scope: Scope;
  node: NodeView | null;
  documents: ScopeDocuments;
}) {
  const { scope, documents } = props;
  return (
    <nav
      aria-label="Settings scope"
      class="-mx-1 mb-6 flex gap-1 overflow-x-auto pb-1"
    >
      <ScopeTab
        href="/settings/fleet"
        label="Fleet"
        current={scope === 'fleet'}
        count={countKeys(documents.get('fleet'))}
      />
      {ROLES.filter(
        (role) =>
          isActiveRole(role) || countKeys(documents.get(`role:${role}`)) > 0
      ).map((role) => (
        <ScopeTab
          key={role}
          href={`/settings/role:${role}`}
          label={role}
          current={scope === `role:${role}`}
          count={countKeys(documents.get(`role:${role}`))}
        />
      ))}
      {props.node === null ? null : (
        <ScopeTab
          href={`/settings/${scope}`}
          label={`Node ${props.node.label}`}
          current
          count={countKeys(documents.get(scope))}
        />
      )}
    </nav>
  );
}

function scopeBlurb(scope: Scope, node: NodeView | null): string {
  if (scope === 'fleet')
    return 'Applies to every node. A role or a single node can override any value.';
  if (scope.startsWith('role:'))
    return `Applies to every ${scope.slice(5)} node and overrides the fleet. A single node can still override it. Empty fields inherit.`;
  return `Applies to ${node?.label ?? 'one node'} only and overrides its role and the fleet. Empty fields inherit.`;
}

function SectionCard(props: {
  section: (typeof SECTIONS)[number];
  p: SettingsPageProps;
  inherited: ReturnType<typeof inheritedSettings>;
}) {
  const { section, p } = props;
  const meta = SECTION_META[section];
  const split = splitErrors(p.errors);
  const stored = (
    p.stored as Record<string, Record<string, unknown> | undefined>
  )['alerts']?.['webhookUrl'];
  return (
    <section class="card overflow-hidden" aria-labelledby={`s-${section}`}>
      <div class="px-4 py-3 sm:px-5">
        <h2 id={`s-${section}`} class="text-base font-semibold">
          {meta.title}
        </h2>
        <p class="text-sm text-fg-2">{meta.blurb}</p>
      </div>
      {Object.entries(RULES[section]).map(([key, rule]) => (
        <SettingField
          key={key}
          section={section}
          key_={key}
          rule={rule}
          value={p.draft[section]?.[key]}
          error={split.byField.get(`${section}.${key}`)}
          inherited={props.inherited.get(`${section}.${key}`)}
          storedUrl={typeof stored === 'string' ? stored : null}
        />
      ))}
    </section>
  );
}

function ErrorSummary(props: { errors: readonly string[] }) {
  const { general, byField } = splitErrors(props.errors);
  if (props.errors.length === 0) return null;
  return (
    <div
      role="alert"
      class="mb-5 rounded-lg border border-bad-dot/40 bg-bad-soft px-4 py-3 text-sm text-bad"
    >
      <p class="font-semibold">
        Nothing was saved. Fix{' '}
        {props.errors.length === 1 ? 'this problem' : 'these problems'} and try
        again.
      </p>
      <ul class="mt-1 list-disc pl-5">
        {[...byField.values(), ...general].map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
    </div>
  );
}

export function SettingsForm(props: SettingsPageProps) {
  const role = props.node?.role ?? null;
  const inherited = inheritedSettings(props.scope, props.documents, role);
  return (
    <form method="post" action={`/settings/${props.scope}`} class="space-y-5">
      <input type="hidden" name="mode" value="form" />
      <ErrorSummary errors={props.errors} />
      {SECTIONS.map((section) => (
        <SectionCard
          key={section}
          section={section}
          p={props}
          inherited={inherited}
        />
      ))}
      <div class="sticky bottom-0 z-10 -mx-4 flex items-center justify-between gap-3 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:mx-0 sm:rounded-xl sm:border">
        <p class="hidden text-sm text-fg-2 sm:block">
          Saving updates {scopeLabel(props.scope).toLowerCase()} and records you
          in the history.
        </p>
        <div class="ml-auto flex gap-2">
          <a href={`/settings/${props.scope}`} class="btn">
            Discard
          </a>
          <button type="submit" class="btn btn-primary">
            Save settings
          </button>
        </div>
      </div>
    </form>
  );
}

export function RawEditor(props: SettingsPageProps) {
  const text = props.rawText ?? rawJson(props.stored);
  return (
    <details class="card" open={props.rawError !== null}>
      <summary class="px-4 py-3 text-sm font-medium sm:px-5">
        Advanced: raw JSON
      </summary>
      <form
        method="post"
        action={`/settings/${props.scope}`}
        class="space-y-3 border-t border-line p-4 sm:p-5"
      >
        <input type="hidden" name="mode" value="raw" />
        <div>
          <label class="label" for="raw-json">
            Settings document
          </label>
          <textarea
            id="raw-json"
            name="raw"
            rows={14}
            spellcheck={false}
            class={cx(
              'field font-mono text-xs',
              props.rawError !== null && 'field-invalid'
            )}
            aria-describedby="raw-help"
          >
            {text}
          </textarea>
          <p id="raw-help" class="help">
            Replaces this scope's whole document. Unknown keys are rejected so a
            typo cannot silently do nothing. The webhook shows only its host;
            keep it as shown to leave it unchanged.
          </p>
          {props.rawError === null ? null : (
            <p role="alert" class="mt-1 text-xs font-medium text-bad">
              {props.rawError}
            </p>
          )}
        </div>
        <button type="submit" class="btn">
          Save JSON
        </button>
      </form>
    </details>
  );
}

export function HistoryPanel(props: SettingsPageProps) {
  return (
    <section class="card" aria-labelledby="history-title">
      <div class="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
        <Icon name="history" class="text-fg-3" />
        <h2 id="history-title" class="text-sm font-semibold">
          Change history
        </h2>
      </div>
      {props.history.length === 0 ? (
        <p class="px-4 py-6 text-fg-2 sm:px-5">
          No changes have been saved for this scope yet.
        </p>
      ) : (
        <ol class="divide-y divide-line">
          {props.history.map((entry, index) => (
            <li
              key={entry.id}
              class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
            >
              <div>
                <p class="text-sm">
                  <span class="font-medium">
                    {entry.changedBy ?? 'unknown'}
                  </span>
                  {index === 0 ? (
                    <span class="ml-2 rounded bg-ok-soft px-1.5 py-0.5 text-xs font-medium text-ok">
                      current
                    </span>
                  ) : null}
                </p>
                <p class="text-xs text-fg-3">
                  <Time at={entry.changedAt} now={props.now} /> ·{' '}
                  {countKeys(entry.value as FleetConfig)} settings
                </p>
              </div>
              {index === 0 ? null : (
                <form method="post" action={`/settings/${props.scope}/restore`}>
                  <input
                    type="hidden"
                    name="historyId"
                    value={String(entry.id)}
                  />
                  <button type="submit" class="btn btn-sm">
                    Restore this version
                  </button>
                </form>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function SettingsBody(props: SettingsPageProps) {
  return (
    <div>
      <ScopeSwitcher
        scope={props.scope}
        node={props.node}
        documents={props.documents}
      />
      <p class="mb-5 max-w-prose text-fg-2">
        {scopeBlurb(props.scope, props.node)}
      </p>
      <div class="space-y-6">
        <SettingsForm {...props} />
        <RawEditor {...props} />
        <HistoryPanel {...props} />
      </div>
    </div>
  );
}
