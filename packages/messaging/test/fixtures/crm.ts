/** A small CRM for chatter tests: deals with a tracked state, partner and amount, and a restricted margin. */
import { defineModule as defineKoshModule } from '@isahaq/kosh-modules-sdk';
import { baseShutro } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
import { messaging, messagingShutro } from '../../src/index.js';

const { defineGroup, defineModel, defineModule, f } = orm;

const Partner = defineModel('res.partner', {
  access: { 'crm.user': ['read'] },
  fields: { name: f.char({ required: true }) },
});

const Deal = defineModel('crm.deal', {
  access: { 'crm.user': ['read', 'write', 'create'] },
  rules: {
    own: { groups: ['crm.user'], perms: ['read', 'write'], domain: { createdBy: { $env: 'uid' } } },
    all: { groups: ['crm.manager'], perms: ['read', 'write'], domain: {} },
  },
  tracking: ['partner', 'amount', 'margin'],
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner'),
    amount: f.decimal({ scale: 2, default: '0' }),
    margin: f.decimal({ scale: 2, groups: ['crm.manager'] }),
    state: f.state({
      states: { new: 'New', won: 'Won', lost: 'Lost' },
      initial: 'new',
      transitions: { win: { from: ['new'], to: 'won' }, lose: { from: ['new'], to: 'lost' } },
    }),
  },
});

const crmShutro = defineModule({
  name: 'crm',
  version: '0.1.0',
  depends: [baseShutro, messagingShutro],
  groups: [
    defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] }),
    defineGroup({ code: 'crm.manager', label: 'CRM manager', implies: ['crm.user'] }),
  ],
  models: [Partner, Deal],
});

export const crm = defineKoshModule({
  shutro: crmShutro,
  kosh: '^0.1.0',
  depends: [messaging],
  accessLevels: {
    user: { label: 'User', groups: ['crm.user'] },
    manager: { label: 'Manager', groups: ['crm.manager'], implies: ['user'] },
  },
});
