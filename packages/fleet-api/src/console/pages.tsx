/** @jsxImportSource react */
import { Alert, Button, Stack } from '@mantine/core';
import type { ConsoleState } from './model';
import { Overview } from './overview';
import { Nodes } from './nodes';
import { Events } from './events';
import { NodeDetail } from './node-detail';
import { Pending } from './pending';
import { Settings } from './settings';
import { Access } from './access-list';
import { AddNode } from './add-node';
export function Pages({
  state,
  path,
  reload,
}: {
  state: ConsoleState;
  path: string;
  reload: () => void;
}) {
  const pathname = path.split('?')[0] ?? '/';
  if (pathname === '/') return <Overview state={state} />;
  if (pathname === '/nodes') return <Nodes state={state} path={path} />;
  if (pathname.startsWith('/nodes/'))
    return <NodeDetail state={state} id={pathname.slice(7)} reload={reload} />;
  if (pathname === '/pending') return <Pending state={state} reload={reload} />;
  if (pathname === '/events') return <Events state={state} path={path} />;
  if (pathname.startsWith('/settings'))
    return <Settings state={state} path={pathname} reload={reload} />;
  if (pathname === '/access') return <Access state={state} reload={reload} />;
  if (pathname === '/add') return <AddNode />;
  return (
    <Stack>
      <Alert color="yellow" title="Page not found">
        This page is unavailable.
      </Alert>
      <Button component="a" href="/">
        Back to overview
      </Button>
    </Stack>
  );
}
