/** @jsxImportSource react */
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
import { SettingsSafetyNotices } from './settings-safety';
import { UnsavedDialog } from './unsaved';
import { useSettingsEditor } from './use-settings-editor';
import type { useAction } from './action';
export function SettingsEditor({
  scope,
  state,
  reload,
}: {
  scope: Scope;
  state: ConsoleState;
  reload: () => void;
}) {
  const editor = useSettingsEditor({ scope, state, reload });
  const { action, dirty } = editor;
  return (
    <Stack>
      <UnsavedDialog navigation={editor.navigation} busy={action.busy} />
      <ErrorNotice
        message={action.problem?.code === 'conflict' ? '' : action.error}
      />
      {editor.readOnly && (
        <Alert color="gray" role="status">
          You are a viewer: you can read these settings but not change them.
        </Alert>
      )}
      <SettingsSafetyNotices
        problem={action.problem}
        busy={action.busy}
        discard={editor.discard}
        confirm={editor.confirm}
      />
      {(!dirty || editor.previewed) && action.success && (
        <Alert color="teal" role="status">
          {action.success}
        </Alert>
      )}
      <SettingsForm
        stored={editor.stored}
        values={editor.values}
        inherited={inheritanceFor(state, scope)}
        update={editor.update}
        action={action}
        save={() => editor.save('form')}
        preview={() => editor.save('form', { intent: 'preview' })}
        readOnly={editor.readOnly}
      />
      <RawSettings
        raw={editor.raw}
        setRaw={editor.setRaw}
        busy={action.busy || editor.readOnly}
        save={() => editor.save('raw')}
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
function SaveBar({
  busy,
  readOnly,
  preview,
}: {
  busy: boolean;
  readOnly: boolean;
  preview: () => void;
}) {
  return (
    <Group justify="flex-end">
      <Button variant="default" disabled={busy || readOnly} onClick={preview}>
        Preview impact
      </Button>
      <Button type="submit" loading={busy} disabled={readOnly}>
        Save settings
      </Button>
    </Group>
  );
}
function SettingsForm({
  stored,
  values,
  inherited,
  update,
  action,
  save,
  preview,
  readOnly,
}: {
  stored: FleetConfig;
  values: Record<string, string>;
  inherited: ReturnType<typeof inheritedSettings>;
  update: (path: string, value: string) => void;
  action: EditorAction;
  save: () => Promise<void>;
  preview: () => Promise<void>;
  readOnly: boolean;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Stack gap="lg">
        <Fieldset disabled={action.busy || readOnly} variant="unstyled">
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
        <SaveBar
          busy={action.busy}
          readOnly={readOnly}
          preview={() => void preview()}
        />
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
