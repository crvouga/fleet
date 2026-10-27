import type { Child } from 'hono/jsx';

import type { RULES, SECTIONS } from '../../config/schema';
import { FieldError } from '../components/forms';
import {
  displayValue,
  scopeLabel,
  type EffectiveSetting,
} from '../lib/effective';
import { maskUrl } from '../lib/format';
import { settingMeta } from '../lib/setting-meta';
import { cx } from '../lib/tw';

type Rule = (typeof RULES)[(typeof SECTIONS)[number]][string];

export interface FieldProps {
  readonly section: string;
  readonly key_: string;
  readonly rule: Rule;
  readonly value: unknown;
  readonly error: string | undefined;
  readonly inherited: EffectiveSetting | undefined;
  readonly storedUrl: string | null;
}

function inheritText(inherited: EffectiveSetting | undefined): string {
  if (inherited === undefined) return 'built-in default';
  const source =
    inherited.source === null ? '' : ` (${scopeLabel(inherited.source)})`;
  return `${displayValue(inherited.value)}${source}`;
}

function Shell(props: {
  id: string;
  label: string;
  unit?: string | undefined;
  help: string;
  hint: string;
  error: string | undefined;
  group?: boolean;
  children?: Child;
}) {
  const Wrapper = props.group === true ? 'fieldset' : 'div';
  return (
    <Wrapper class="grid gap-3 border-t border-line px-4 py-4 first:border-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,18rem)] sm:gap-6 sm:px-5">
      <div class="min-w-0">
        {props.group === true ? (
          <legend class="label mb-0">{props.label}</legend>
        ) : (
          <label class="label mb-0" for={props.id}>
            {props.label}
          </label>
        )}
        <p id={`${props.id}-help`} class="help mt-0.5">
          {props.help}
        </p>
        <p class="mt-1 text-xs text-fg-3">{props.hint}</p>
      </div>
      <div class="min-w-0">
        {props.children}
        {props.unit === undefined ? null : (
          <p class="mt-1 text-xs text-fg-3">{props.unit}</p>
        )}
        <FieldError id={`${props.id}-error`} message={props.error} />
      </div>
    </Wrapper>
  );
}

function describedBy(id: string, error: string | undefined): string {
  return error === undefined ? `${id}-help` : `${id}-help ${id}-error`;
}

function IntField(
  props: FieldProps & { rule: Extract<Rule, { kind: 'int' }> }
) {
  const path = `${props.section}.${props.key_}`;
  const id = `f-${props.section}-${props.key_}`;
  const meta = settingMeta(props.section, props.key_);
  const { rule } = props;
  return (
    <Shell
      id={id}
      label={meta.label}
      unit={meta.unit}
      help={meta.help}
      error={props.error}
      hint={`Allowed ${rule.min} to ${rule.max}. Empty inherits: ${inheritText(props.inherited)}.`}
    >
      <input
        id={id}
        name={path}
        type="number"
        inputmode="numeric"
        min={rule.min}
        max={rule.max}
        step={1}
        value={props.value === undefined ? '' : String(props.value)}
        placeholder={
          props.inherited === undefined
            ? 'inherit'
            : displayValue(props.inherited.value)
        }
        aria-describedby={describedBy(id, props.error)}
        aria-invalid={props.error === undefined ? undefined : 'true'}
        class={cx(
          'field tabular',
          props.error !== undefined && 'field-invalid'
        )}
      />
    </Shell>
  );
}

const CHOICES: readonly { value: string; label: string }[] = [
  { value: '', label: 'Inherit' },
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
];

function BoolField(props: FieldProps) {
  const path = `${props.section}.${props.key_}`;
  const id = `f-${props.section}-${props.key_}`;
  const meta = settingMeta(props.section, props.key_);
  const selected =
    props.value === true ? 'true' : props.value === false ? 'false' : '';
  return (
    <Shell
      id={id}
      group
      label={meta.label}
      help={meta.help}
      error={props.error}
      hint={`Inherit uses: ${inheritText(props.inherited)}.`}
    >
      <div
        class="inline-flex rounded-lg border border-line-strong bg-muted p-0.5"
        role="presentation"
      >
        {CHOICES.map((choice) => (
          <label key={choice.value} class="relative">
            <input
              type="radio"
              name={path}
              value={choice.value}
              checked={selected === choice.value}
              class="peer sr-only"
              aria-describedby={`${id}-help`}
            />
            <span class="block cursor-pointer rounded-md px-3 py-1 text-sm font-medium text-fg-2 peer-checked:bg-surface peer-checked:text-fg peer-checked:shadow-card peer-focus-visible:outline-2 peer-focus-visible:outline-accent">
              {choice.label}
            </span>
          </label>
        ))}
      </div>
    </Shell>
  );
}

function ListField(
  props: FieldProps & { rule: Extract<Rule, { kind: 'list' }> }
) {
  const path = `${props.section}.${props.key_}`;
  const id = `f-${props.section}-${props.key_}`;
  const meta = settingMeta(props.section, props.key_);
  const items = Array.isArray(props.value) ? props.value.map(String) : [];
  return (
    <Shell
      id={id}
      label={meta.label}
      unit={meta.unit}
      help={meta.help}
      error={props.error}
      hint={`Up to ${props.rule.max} entries. Empty inherits: ${inheritText(props.inherited)}.`}
    >
      <textarea
        id={id}
        name={path}
        rows={Math.min(8, Math.max(3, items.length + 1))}
        spellcheck={false}
        aria-describedby={describedBy(id, props.error)}
        aria-invalid={props.error === undefined ? undefined : 'true'}
        class={cx(
          'field font-mono text-xs',
          props.error !== undefined && 'field-invalid'
        )}
      >
        {items.join('\n')}
      </textarea>
    </Shell>
  );
}

function UrlField(props: FieldProps) {
  const path = `${props.section}.${props.key_}`;
  const id = `f-${props.section}-${props.key_}`;
  const meta = settingMeta(props.section, props.key_);
  const typed =
    typeof props.value === 'string' && props.value !== props.storedUrl
      ? props.value
      : '';
  return (
    <Shell
      id={id}
      label={meta.label}
      unit={meta.unit}
      help={meta.help}
      error={props.error}
      hint={`Currently: ${maskUrl(props.storedUrl)}. Leave empty to keep it.`}
    >
      <input
        id={id}
        name={path}
        type="url"
        value={typed}
        autocomplete="off"
        placeholder="https://hooks.example.com/..."
        aria-describedby={describedBy(id, props.error)}
        aria-invalid={props.error === undefined ? undefined : 'true'}
        class={cx('field', props.error !== undefined && 'field-invalid')}
      />
      {props.storedUrl === null ? null : (
        <label class="mt-2 flex items-center gap-2 text-sm text-fg-2">
          <input type="checkbox" name={`${path}.__clear`} value="1" />
          Remove the saved webhook
        </label>
      )}
    </Shell>
  );
}

/** One setting, rendered as the control its rule calls for. */
export function SettingField(props: FieldProps) {
  const { rule } = props;
  switch (rule.kind) {
    case 'int':
      return <IntField {...props} rule={rule} />;
    case 'bool':
      return <BoolField {...props} />;
    case 'list':
      return <ListField {...props} rule={rule} />;
    case 'url-or-null':
      return <UrlField {...props} />;
  }
}
