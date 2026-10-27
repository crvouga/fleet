/** @jsxImportSource react */
import { useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  Alert,
  Button,
  Fieldset,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import { ErrorNotice } from '@pkgs/admin-ui/components';
import { RULES, SECTIONS, type FleetConfig, type Rule } from '../config/fields';
import type { Scope } from '../config/schema';
import type { ConsoleState } from './model';
import { SECTION_META, settingMeta } from '../ui/lib/setting-meta';
import { inheritedSettings, displayValue } from '../ui/lib/effective';
import { useAction } from './action';
import { useUnsavedChanges, UnsavedDialog } from './unsaved';
function initialFields(config: FleetConfig): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [section, entries] of Object.entries(config))
    for (const [key, value] of Object.entries(
      entries as Record<string, unknown>
    ))
      values[`${section}.${key}`] = Array.isArray(value)
        ? value.join('\n')
        : String(value ?? '');
  values['alerts.webhookUrl'] = '';
  return values;
}
export function SettingsEditor({
  scope,
  state,
  reload,
}: {
  scope: Scope;
  state: ConsoleState;
  reload: () => void;
}) {
  const stored = useMemo(
    () => state.fleet.documents.get(scope) ?? {},
    [state.fleet.documents, scope]
  );
  const [values, setValues] = useState(() => initialFields(stored));
  const [raw, setRaw] = useState(() => JSON.stringify(stored, null, 2));
  const [dirty, setDirty] = useState(false);
  const action = useAction(reload);
  const navigation = useUnsavedChanges(dirty || action.busy);
  useEffect(() => {
    if (!dirty) {
      setValues(initialFields(stored));
      setRaw(JSON.stringify(stored, null, 2));
    }
  }, [stored, dirty]);
  async function save(mode: string) {
    if (
      await action.run(
        `/settings/${scope}`,
        mode === 'raw' ? { mode, raw } : { mode, ...values }
      )
    )
      setDirty(false);
  }
  const inherited = inheritanceFor(state, scope);
  function update(path: string, value: string) {
    setValues((old) => ({ ...old, [path]: value }));
    setDirty(true);
  }
  return (
    <Stack>
      <UnsavedDialog navigation={navigation} busy={action.busy} />
      <ErrorNotice message={action.error} />
      {!dirty && action.success && (
        <Alert color="teal" role="status">
          {action.success}
        </Alert>
      )}
      <SettingsForm
        stored={stored}
        values={values}
        inherited={inherited}
        update={update}
        action={action}
        save={() => save('form')}
      />
      <RawSettings
        raw={raw}
        setRaw={(value) => {
          setRaw(value);
          setDirty(true);
        }}
        busy={action.busy}
        save={() => save('raw')}
      />
    </Stack>
  );
}
function SettingsField({
  path,
  rule,
  value,
  inherited,
  onChange,
}: {
  path: string;
  rule: Rule;
  value: string;
  inherited: string;
  onChange: (value: string) => void;
}) {
  const [section, key] = path.split('.');
  const meta = settingMeta(section!, key!);
  const common = {
    label: meta.label,
    description: `${meta.help} Empty inherits: ${inherited}`,
    name: path,
  };
  if (rule.kind === 'bool')
    return (
      <NativeSelect
        {...common}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        data={[
          { value: '', label: 'Inherit' },
          { value: 'true', label: 'On' },
          { value: 'false', label: 'Off' },
        ]}
      />
    );
  if (rule.kind === 'int')
    return (
      <NumberInput
        {...common}
        min={rule.min}
        max={rule.max}
        allowDecimal={false}
        hideControls
        value={value ? Number(value) : ''}
        onChange={(next) => onChange(String(next))}
        placeholder={`${rule.min}–${rule.max}`}
      />
    );
  if (rule.kind === 'list')
    return (
      <Textarea
        {...common}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        minRows={3}
        autosize
      />
    );
  return (
    <TextInput
      {...common}
      type="url"
      autoComplete="off"
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      placeholder="https://…"
    />
  );
}

type EditorAction = ReturnType<typeof useAction>;
function SettingsForm({
  stored,
  values,
  inherited,
  update,
  action,
  save,
}: {
  stored: FleetConfig;
  values: Record<string, string>;
  inherited: ReturnType<typeof inheritedSettings>;
  update: (path: string, value: string) => void;
  action: EditorAction;
  save: () => Promise<void>;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack gap="lg">
        <Fieldset disabled={action.busy} variant="unstyled">
          <Stack gap="lg">
            {SECTIONS.map((section) => (
              <SettingsSection
                key={section}
                section={section}
                values={values}
                inherited={inherited}
                update={update}
              />
            ))}
          </Stack>
        </Fieldset>
        {stored.alerts?.webhookUrl && (
          <Alert color="gray" title="Saved alert webhook">
            Currently: {stored.alerts.webhookUrl}. Leave the field empty to keep
            it.
            <Button
              variant="subtle"
              color="red"
              size="xs"
              onClick={() =>
                update(
                  'alerts.webhookUrl.__clear',
                  values['alerts.webhookUrl.__clear'] ? '' : '1'
                )
              }
            >
              {values['alerts.webhookUrl.__clear']
                ? 'Keep saved webhook'
                : 'Remove the saved webhook'}
            </Button>
          </Alert>
        )}
        <Group justify="flex-end">
          <Button type="submit" loading={action.busy}>
            Save settings
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
function SettingsSection({
  section,
  values,
  inherited,
  update,
}: {
  section: (typeof SECTIONS)[number];
  values: Record<string, string>;
  inherited: ReturnType<typeof inheritedSettings>;
  update: (path: string, value: string) => void;
}) {
  return (
    <Paper withBorder p="lg">
      <Stack>
        <Title order={2} size="h4">
          {SECTION_META[section].title}
        </Title>
        <Text size="sm" c="dimmed">
          {SECTION_META[section].blurb}
        </Text>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          {Object.entries(RULES[section]).map(([key, rule]) => {
            const path = `${section}.${key}`;
            const source = inherited.get(path);
            return (
              <SettingsField
                key={path}
                path={path}
                rule={rule}
                value={values[path] ?? ''}
                inherited={
                  source
                    ? `${displayValue(source.value)} (${source.source ?? 'default'})`
                    : 'Built-in default'
                }
                onChange={(value) => update(path, value)}
              />
            );
          })}
        </SimpleGrid>
      </Stack>
    </Paper>
  );
}
function RawSettings({
  raw,
  setRaw,
  busy,
  save,
}: {
  raw: string;
  setRaw: (value: string) => void;
  busy: boolean;
  save: () => Promise<void>;
}) {
  return (
    <Accordion variant="separated">
      <Accordion.Item value="raw">
        <Accordion.Control>Advanced: raw JSON</Accordion.Control>
        <Accordion.Panel>
          <Stack>
            <Textarea
              label="Settings JSON"
              autosize
              minRows={8}
              maxRows={24}
              value={raw}
              disabled={busy}
              onChange={(event) => setRaw(event.currentTarget.value)}
            />
            <Group justify="flex-end">
              <Button loading={busy} onClick={save}>
                Save raw JSON
              </Button>
            </Group>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function inheritanceFor(state: ConsoleState, scope: Scope) {
  const entry = state.fleet.entries.find(
    (item) => scope === `node:${item.view.id}`
  );
  return inheritedSettings(
    scope,
    state.fleet.documents,
    entry?.view.role ?? null
  );
}
