/** @jsxImportSource react */
import {
  Alert,
  Button,
  CopyButton,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconCheck,
  IconCopy,
  IconKey,
  IconAlertCircle,
} from '@tabler/icons-react';
import type { ReactNode } from 'react';

export function AdminBrand({
  name,
  subtitle = 'Admin console',
  icon,
}: {
  name: string;
  subtitle?: string;
  icon?: ReactNode;
}) {
  return (
    <Group gap="sm" wrap="nowrap">
      <ThemeIcon size={36} radius="md">
        {icon ?? <IconKey size={21} />}
      </ThemeIcon>
      <Stack gap={0}>
        <Text fw={750} size="lg" lh={1.2}>
          {name}
        </Text>
        <Text size="xs" c="dimmed" visibleFrom="xs">
          {subtitle}
        </Text>
      </Stack>
    </Group>
  );
}

export function PageHeading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" mb="xl">
      <Stack gap={5}>
        <Title order={1} size="h2" tabIndex={-1}>
          {title}
        </Title>
        <Text c="dimmed" size="sm">
          {description}
        </Text>
      </Stack>
      {action}
    </Group>
  );
}

export function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  if (!message) return null;
  return (
    <Alert
      color="red"
      title="Something needs attention"
      icon={<IconAlertCircle size={18} />}
      role="alert"
    >
      <Stack gap="sm">
        <Text size="sm">{message}</Text>
        {retry && (
          <Button variant="light" color="red" size="xs" onClick={retry}>
            Try again
          </Button>
        )}
      </Stack>
    </Alert>
  );
}

export function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4} miw={0}>
          <Text size="xs" c="dimmed" fw={600}>
            {label}
          </Text>
          <Text size="sm" ff="monospace" className="break-word">
            {value}
          </Text>
        </Stack>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <Button
              variant="subtle"
              size="compact-xs"
              color={copied ? 'teal' : 'gray'}
              onClick={copy}
              aria-label={`Copy ${label}`}
              leftSection={
                copied ? <IconCheck size={14} /> : <IconCopy size={14} />
              }
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          )}
        </CopyButton>
      </Group>
    </Paper>
  );
}
