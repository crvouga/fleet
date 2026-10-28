/** @jsxImportSource react */
import { useState } from 'react';
import { Alert, Button, Checkbox, Group, Stack } from '@mantine/core';
import type { ActionProblem } from './action';

/**
 * What the server said when it refused a settings save: someone else saved
 * first (conflict), or the change could destabilise the fleet and needs the
 * person to confirm each warning. Nothing here changes the stored settings.
 */
export function SettingsSafetyNotices({
  problem,
  busy,
  discard,
  confirm,
}: {
  problem: ActionProblem | null;
  busy: boolean;
  /** Drop the edits and load the latest stored settings. */
  discard: () => void;
  /** Save again acknowledging exactly these warning codes. */
  confirm: (codes: string[]) => void;
}) {
  const [ticked, setTicked] = useState<string[]>([]);
  if (problem?.code === 'conflict')
    return (
      <Alert color="red" title="Nothing was saved: these settings changed">
        <Stack gap="xs">
          Someone saved these settings after you opened the page, and saving
          would have overwritten their change. Your edits are still in the form
          below. Load the latest version, review it, then apply your edits
          again.
          <Group>
            <Button size="xs" variant="light" onClick={discard}>
              Discard my edits and load the latest
            </Button>
          </Group>
        </Stack>
      </Alert>
    );
  const issues = (problem?.issues ?? []).filter((issue) => issue.blocking);
  if (problem?.code !== 'unsafe_change' || issues.length === 0) return null;
  const all = issues.every((issue) => ticked.includes(issue.code));
  return (
    <Alert color="orange" title="This change could destabilise the fleet">
      <Stack gap="xs">
        {issues.map((issue) => (
          <Checkbox
            key={issue.code}
            label={`I understand: ${issue.message}`}
            checked={ticked.includes(issue.code)}
            onChange={(event) =>
              setTicked((old) =>
                event.currentTarget.checked
                  ? [...old, issue.code]
                  : old.filter((code) => code !== issue.code)
              )
            }
          />
        ))}
        <Group>
          <Button
            size="xs"
            color="orange"
            disabled={!all || busy}
            onClick={() => confirm(issues.map((issue) => issue.code))}
          >
            Save with these warnings acknowledged
          </Button>
        </Group>
      </Stack>
    </Alert>
  );
}
