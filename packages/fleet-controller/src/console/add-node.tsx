/** @jsxImportSource react */
import { useEffect, useState } from 'react';
import {
  Accordion,
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  NativeSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PageHeading } from '@pkgs/admin-ui/components';
import { ACTIVE_ROLES, type ActiveRole } from '../types';
import {
  INSTALLERS,
  INSTALLER_RELEASE,
  WINDOWS_DOWNLOAD_GUIDE,
  installerUrl,
} from '../ui/lib/installers';
import { detectedPlatform, type PlatformHints } from './platform';
import { InstallerBinding } from './installer-binding';
import { HardwareTiers } from './hardware-tiers';
const ROLE_LABELS: Record<ActiveRole, string> = {
  ci: 'GitHub Actions runners',
  devbox: 'Developer workstation',
};
const roles = ACTIVE_ROLES.map((id) => ({ id, label: ROLE_LABELS[id] }));
export function AddNode({ empty = false }: { empty?: boolean }) {
  return (
    <Stack gap="lg">
      <PageHeading
        title={empty ? 'Add your first node' : 'Add a node'}
        description="Enroll a physical machine you own. Every installation asks before changing a disk."
      />
      <Paper withBorder p="xl">
        <Stack gap="xl">
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            {[
              'Download the installer',
              'Install the base system',
              'Approve it here',
              'Assign a role here',
            ].map((title, index) => (
              <Group key={title} wrap="nowrap" align="flex-start">
                <Badge circle variant="light" size="lg">
                  {index + 1}
                </Badge>
                <Stack gap={4}>
                  <Title order={2} size="h5">
                    {title}
                  </Title>
                  <Text size="sm" c="dimmed">
                    {
                      [
                        'Choose the computer that will run the installer below.',
                        'The local wizard checks hardware, reviews the exact disk and installs the same base system on every machine.',
                        'The installer registers with this app. Review and approve the computer under Pending before its disk is erased.',
                        `On its node page, or while approving, choose ${ACTIVE_ROLES.join(' or ')}. It switches on its own, with no reinstall.`,
                      ][index]
                    }
                  </Text>
                </Stack>
              </Group>
            ))}
          </SimpleGrid>
          <Group>
            {roles.map((role) => (
              <Badge
                key={role.id}
                color="gray"
                variant="light"
                title={role.label}
              >
                {role.id}
              </Badge>
            ))}
          </Group>
          <Downloads />
          <InstallerBinding />
          <HardwareTiers />
          <Alert color="yellow">
            macOS is unsigned, and Windows can show download or publisher
            warnings. Installation can erase a disk; review the exact target and
            retain your recovery information.
          </Alert>
          <Anchor href="/pending" size="sm">
            Already ran it? See pending approvals
          </Anchor>
        </Stack>
      </Paper>
    </Stack>
  );
}
function Downloads() {
  const { selection, select, detected } = useInstallerPlatform();
  const platform = selection || detected;
  const installer = INSTALLERS.find((item) => item.id === platform);
  return (
    <Stack id="installer-downloads" gap="md">
      <Text data-installer-status role="status" size="sm" c="dimmed">
        {downloadStatus(installer?.label, platform, !!selection)}
      </Text>
      <Button
        component="a"
        href={
          installer
            ? installerUrl(installer.file)
            : platform === 'nixos'
              ? '#nixos-install'
              : undefined
        }
        data-installer-recommended
        hidden={!installer && platform !== 'nixos'}
      >
        {platform === 'nixos'
          ? 'Use the native NixOS installer'
          : `Download ${installer?.label ?? 'recommended installer'}`}
      </Button>
      {platform === 'windows-x64' && (
        <Alert color="yellow" title="If Microsoft Edge blocks the download">
          Edge may say the installer “isn’t commonly downloaded.” New or
          unsigned Windows downloads may not have established publisher
          reputation. Compare the download’s SHA-256 with the release before
          opening it. The wizard cannot fix a browser block before it starts.
          Keep Windows protection enabled. If your organization blocks
          unrecognized apps, use another permitted computer to make installer
          USB media or contact its administrator.
          <Anchor
            href={WINDOWS_DOWNLOAD_GUIDE}
            target="_blank"
            rel="noopener noreferrer"
            ml="xs"
          >
            Windows download and verification guide
          </Anchor>
        </Alert>
      )}
      <NativeSelect
        id="installer-platform"
        label="Installer for"
        value={selection}
        onChange={(event) => select(event.currentTarget.value)}
        data={[
          { value: '', label: 'Auto-detect this computer' },
          ...INSTALLERS.map((item) => ({ value: item.id, label: item.label })),
          { value: 'nixos', label: 'NixOS — native installer' },
        ]}
      />
      <InstallerChoices platform={platform} />
      <Anchor
        href={INSTALLER_RELEASE}
        target="_blank"
        rel="noopener noreferrer"
        size="sm"
      >
        Open the installer release
      </Anchor>
    </Stack>
  );
}

function InstallerChoices({ platform }: { platform: string }) {
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => {
    if (platform === 'nixos') setOpened('nixos');
  }, [platform]);
  return (
    <Accordion variant="separated" value={opened} onChange={setOpened}>
      <Accordion.Item value="all">
        <Accordion.Control>All installers</Accordion.Control>
        <Accordion.Panel data-installer-choices>
          <Stack gap="sm">
            {INSTALLERS.map((item) => (
              <Anchor key={item.id} href={installerUrl(item.file)}>
                {item.label}
              </Anchor>
            ))}
            <Anchor href="#nixos-install">NixOS — native installer</Anchor>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
      <Accordion.Item value="nixos" id="nixos-install">
        <Accordion.Control>Installing or reinstalling NixOS?</Accordion.Control>
        <Accordion.Panel>
          <Stack>
            <Text size="sm">
              Run the native installer in a terminal and open the local address
              it prints. This also supports reinstalling an existing fleet node.
            </Text>
            <Anchor href="/installers/nixos">
              Show the native installer command
            </Anchor>
            <Text size="sm" c="dimmed">
              Existing fleet machines already include fleet-installer and
              fleet-node. Do not use a foreign Linux binary on NixOS.
            </Text>
          </Stack>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

function downloadStatus(
  label: string | undefined,
  platform: string,
  selected: boolean
) {
  return label
    ? `${selected ? 'Selected installer:' : 'Recommended for this computer:'} ${label}.`
    : platform === 'nixos'
      ? 'Use the native NixOS installer below.'
      : 'Choose the installer for the computer running it. Ambiguous Mac chips are never guessed.';
}

function useInstallerPlatform() {
  const [selection, setSelection] = useState('');
  const [detected, setDetected] = useState('');
  useEffect(() => {
    let active = true;
    try {
      setSelection(sessionStorage.getItem('fleet-installer-platform') ?? '');
    } catch {
      /* Optional preference. */
    }
    setDetected(detectedPlatform(navigator));
    const nav = navigator as Navigator & {
      userAgentData?: {
        getHighEntropyValues(keys: string[]): Promise<PlatformHints>;
      };
    };
    void nav.userAgentData
      ?.getHighEntropyValues(['platform', 'architecture', 'bitness', 'wow64'])
      .then((hints) => {
        if (active) setDetected(detectedPlatform(navigator, hints));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  function select(value: string) {
    setSelection(value);
    try {
      sessionStorage.setItem('fleet-installer-platform', value);
    } catch {
      /* Optional preference. */
    }
  }
  return { selection, select, detected };
}
