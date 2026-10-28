/** @jsxImportSource react */
import { Alert, Button, Stack } from '@mantine/core';
import type { ConsoleState } from './model';
import { Overview } from './overview';
import { Nodes } from './nodes';
import { Events } from './events';
import { Operations } from './operations';
import { AuditLog } from './audit';
import { Incidents } from './incidents';
import { Runners } from './runners';
import { ReportIssue } from './report-issue';
import { NodeDetail } from './node-detail';
import { Pending } from './pending';
import { Settings } from './settings';
import { Access } from './access-list';
import { AddNode } from './add-node';
function CorePages({
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

/** Operations and the audit log, then everything else. */
export function Pages(props: {
  state: ConsoleState;
  path: string;
  reload: () => void;
}) {
  const pathname = props.path.split('?')[0] ?? '/';
  if (pathname === '/operations')
    return <Operations state={props.state} reload={props.reload} />;
  if (pathname === '/audit') return <AuditLog state={props.state} />;
  if (pathname === '/incidents') return <Incidents />;
  if (pathname === '/runners') return <Runners state={props.state} />;
  if (pathname === '/report-issue')
    return <ReportIssue state={props.state} path={props.path} />;
  return <CorePages {...props} />;
}
