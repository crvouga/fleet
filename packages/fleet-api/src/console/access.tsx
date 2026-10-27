/** @jsxImportSource react */
import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconServer } from '@tabler/icons-react';
import { AdminBrand } from '@pkgs/admin-ui/components';
import { ThemePicker } from '@pkgs/admin-ui/theme-picker';
import type { ConsoleState } from './model';
export function SignIn({ state }: { state: ConsoleState }) {
  return (
    <Center mih="100dvh" p="md">
      <Container size={460} w="100%">
        <Stack gap="xl">
          <Group justify="space-between">
            <AdminBrand
              name="Fleet"
              subtitle="Infrastructure console"
              icon={<IconServer size={21} />}
            />
            <ThemePicker />
          </Group>
          <Paper withBorder p="xl">
            <Stack gap="lg">
              <Title order={1} size="h2">
                {state.status === 'denied' ? 'Not allowed' : 'Sign in to Fleet'}
              </Title>
              <AccessMessage state={state} />
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </Center>
  );
}
function AccessMessage({ state }: { state: ConsoleState }) {
  if (state.status === 'denied')
    return (
      <>
        <Text c="dimmed">
          Signed in as {state.actor}. This account is not on Fleet’s access
          list. Ask an administrator to add your email, or use another account.
        </Text>
        <form method="post" action="/logout">
          <Button type="submit" fullWidth>
            Sign out
          </Button>
        </form>
      </>
    );
  return (
    <>
      {state.error && (
        <Alert color="red" role="alert">
          {state.error}
        </Alert>
      )}
      {state.authAvailable ? (
        <>
          <Text c="dimmed">
            Continue with your organization’s identity provider.
          </Text>
          <Button
            component="a"
            href={`/auth/login?next=${encodeURIComponent(state.next ?? '/')}`}
          >
            Sign in with OpenID Connect
          </Button>
        </>
      ) : (
        <Alert color="yellow">
          OpenID Connect sign-in is unavailable until the identity provider is
          configured. Contact your infrastructure administrator.
        </Alert>
      )}
    </>
  );
}
