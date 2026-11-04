/**
 * @packageDocumentation
 * `@kosh/approvals` (RFC 0025): the **Approvals** app on the engine of `@kosh/permissions`. Everyone who decides or
 * asks has it: the inbox (cards with the record, who asked, how long it waits, every level as a step; decided one by
 * one or many at once, from the keyboard too), my requests (withdrawn while they wait), what I decided; and, for
 * Approvals managers, the policies — levels, who decides each and how many — edited on screen.
 */
import { defineModule } from '@kosh/modules-sdk';
import { permissions } from '@kosh/permissions';
import { form, list, search } from '@kosh/views';
import { approvalsShutro } from './module.js';

export { approvalsShutro } from './module.js';

export const approvals: ReturnType<typeof defineModule> = defineModule({
  shutro: approvalsShutro,
  kosh: '^0.1.0',
  depends: [permissions],
  app: {
    code: 'approvals',
    label: 'Approvals',
    icon: 'approvals',
    sequence: 2,
    category: 'Productivity',
    summary: 'Everything waiting for your decision, in one place — and what you asked for',
  },
  accessLevels: {
    user: { label: 'Everyone (decide and ask)', groups: ['base.user'] },
    manager: {
      label: 'Manager (policies)',
      groups: ['approvals.manager'],
      implies: ['user'],
    },
  },
  actions: {
    'approvals.action_inbox': { type: 'client', page: 'approvals.Inbox', label: 'To approve' },
    'approvals.action_mine': { type: 'client', page: 'approvals.Mine', label: 'My requests' },
    'approvals.action_history': {
      type: 'client',
      page: 'approvals.History',
      label: 'What I decided',
    },
    'approvals.action_policies': {
      model: 'approval.policy',
      label: 'Policies',
      views: ['list', 'form'],
      visibleTo: ['approvals.manager'],
    },
  },
  menus: [
    { id: 'approvals.root', label: 'Approvals', app: 'approvals' },
    {
      id: 'approvals.inbox',
      parent: 'approvals.root',
      label: 'To approve',
      action: 'approvals.action_inbox',
      sequence: 1,
    },
    {
      id: 'approvals.mine',
      parent: 'approvals.root',
      label: 'My requests',
      action: 'approvals.action_mine',
      sequence: 2,
    },
    {
      id: 'approvals.history',
      parent: 'approvals.root',
      label: 'What I decided',
      action: 'approvals.action_history',
      sequence: 3,
    },
    {
      id: 'approvals.configuration',
      parent: 'approvals.root',
      label: 'Configuration',
      sequence: 9,
      visibleTo: ['approvals.manager'],
    },
    {
      id: 'approvals.policies',
      parent: 'approvals.configuration',
      label: 'Policies',
      action: 'approvals.action_policies',
      sequence: 1,
      visibleTo: ['approvals.manager'],
    },
  ],
  views: {
    'approval.policy.list': list('approval.policy' as never, {
      columns: [
        'name',
        'targetModel',
        'company',
        'onApproved',
        'reasonRequired',
        'active',
      ] as never,
    }),
    'approval.policy.form': form('approval.policy' as never, (k) => ({
      sheet: [
        k.group('main', ['name', 'targetModel', 'company', 'sequence'] as never, {
          description:
            'A record of the model gets one approval per level whose condition it meets; levels with a lower sequence are decided first, those with the same side by side.',
        }),
        k.group(
          'outcomes',
          ['onApproved', 'onRejected', 'onSentBack', 'onWithdrawn', 'reasonRequired'] as never,
          {
            label: 'What happens',
            description:
              'The transitions of the record run when it is approved, rejected, sent back or withdrawn.',
          },
        ),
        k.lines(
          'levels' as never,
          [
            { field: 'sequence', id: 'level_sequence' },
            { field: 'name', id: 'level_name' },
            { field: 'approverKind', id: 'level_kind' },
            { field: 'approverRole', id: 'level_role' },
            { field: 'approverUsers', id: 'level_users', widget: 'tags' },
            { field: 'approverField', id: 'level_field' },
            { field: 'quorum', id: 'level_quorum' },
            { field: 'quorumCount', id: 'level_count' },
          ] as never,
        ),
      ],
    })),
  },
  search: {
    'approval.policy': search('approval.policy' as never, {
      fields: ['name', 'targetModel'] as never,
      groupBy: ['targetModel'] as never,
    }),
  },
});
