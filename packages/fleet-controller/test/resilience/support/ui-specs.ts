import { operationOf, confirm, fixed, ui, type Spec } from './spec-kit';
import { NODE, send } from './world';

export const UI_SPECS: readonly Spec[] = [
  {
    key: 'POST /nodes/:id/role',
    kind: 'ui-action',
    path: ui(NODE.patch, '/role'),
    form: () => ({ role: 'devbox' }),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/approve',
    kind: 'ui-action',
    path: ui(NODE.uiApprove, '/approve'),
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/reject',
    kind: 'ui-action',
    path: ui(NODE.uiReject, '/reject'),
    form: confirm(NODE.uiReject),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/retire',
    kind: 'ui-action',
    path: ui(NODE.uiRetire, '/retire'),
    form: confirm(NODE.uiRetire),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/delete',
    kind: 'ui-action',
    path: ui(NODE.uiRemove, '/delete'),
    form: confirm(NODE.uiRemove),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/edit',
    kind: 'ui-action',
    path: ui(NODE.patch, '/edit'),
    form: () => ({ displayName: 'Rack one', note: 'n', labels: 'a,b' }),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/recovery/retry-update',
    kind: 'ui-action',
    path: ui(NODE.patch, '/recovery/retry-update'),
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/recovery/reopen-admission',
    kind: 'ui-action',
    path: ui(NODE.patch, '/recovery/reopen-admission'),
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/recovery/rotate-age-key',
    kind: 'ui-action',
    path: ui(NODE.patch, '/recovery/rotate-age-key'),
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/operations/:kind',
    kind: 'ui-action',
    path: ui(NODE.uiDrain, '/operations/drain'),
    form: () => ({}),
    audit: 'row',
    after: async (w) =>
      void w.memo.set('uiOperation', await operationOf(w, NODE.uiDrain)),
  },
  {
    key: 'POST /operations/:id/cancel',
    kind: 'ui-action',
    path: (w) => `/operations/${w.memo.get('uiOperation') ?? 'none'}/cancel`,
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/credential/rotate',
    kind: 'ui-action',
    path: ui(NODE.uiRotate, '/credential/rotate'),
    form: () => ({}),
    audit: 'row',
  },
  {
    key: 'POST /nodes/:id/credential/revoke',
    kind: 'ui-action',
    path: ui(NODE.uiRevoke, '/credential/revoke'),
    form: confirm(NODE.uiRevoke),
    audit: 'row',
  },
  {
    key: 'POST /settings/:scope',
    kind: 'ui-action',
    path: fixed('/settings/role:devbox'),
    form: () => ({
      mode: 'raw',
      raw: JSON.stringify({ disk: { alertPercent: 77 } }),
      expectedRevision: '0',
    }),
    audit: 'row',
    after: async (w) => {
      const history = await send(w, 'GET', '/v1/settings/role:devbox/history', {
        identity: 'adminToken',
      });
      const rows = (history.json as { history: { id: number }[] }).history;
      w.memo.set('uiHistory', String(rows[0]?.id));
    },
  },
  {
    key: 'POST /settings/:scope/restore',
    kind: 'ui-action',
    path: fixed('/settings/role:devbox/restore'),
    form: (w) => ({
      historyId: w.memo.get('uiHistory') ?? '0',
      expectedRevision: '1',
    }),
    audit: 'row',
  },
  {
    key: 'POST /report-issue',
    kind: 'ui-action',
    path: fixed('/report-issue'),
    form: () => ({ draft: 'none' }),
    audit:
      'needs the issue-reporting runtime, absent here; filing is audited by the service (test/issues)',
  },
];
