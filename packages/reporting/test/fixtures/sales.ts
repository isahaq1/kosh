/** A small sales app for report tests: orders with partner, state, date, a monetary amount and a restricted margin. */
import { defineModule as defineKoshModule } from '@kosh/modules-sdk';
import { baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { reporting, reportingShutro } from '../../src/index.js';

const { defineGroup, defineModel, defineModule, f } = orm;

const Partner = defineModel('res.partner', {
  access: { 'sale.user': ['read'] },
  fields: { name: f.char({ required: true }), city: f.char() },
});

const Order = defineModel('sale.order', {
  history: true,
  access: {
    'sale.user': ['read', 'write', 'create'],
    'sale.manager': ['read', 'write', 'create', 'export'],
  },
  rules: {
    own: {
      groups: ['sale.user'],
      perms: ['read', 'write'],
      domain: { createdBy: { $env: 'uid' } },
    },
    all: { groups: ['sale.manager'], perms: ['read', 'write'], domain: {} },
  },
  fields: {
    name: f.char({ required: true }),
    partner: f.many2one('res.partner', { required: true }),
    state: f.selection({ draft: 'Draft', sale: 'Confirmed' }, { required: true, default: 'draft' }),
    dateOrder: f.date({ required: true }),
    currency: f.many2one('res.currency', { required: true }),
    amount: f.monetary({ currency: 'currency', required: true }),
    qty: f.integer({ default: 1 }),
    margin: f.decimal({ scale: 2, groups: ['sale.manager'] }),
  },
});

const saleShutro = defineModule({
  name: 'sale',
  version: '0.1.0',
  depends: [baseShutro, reportingShutro],
  groups: [
    defineGroup({ code: 'sale.user', label: 'Sales', implies: ['base.user'] }),
    defineGroup({ code: 'sale.manager', label: 'Sales manager', implies: ['sale.user'] }),
  ],
  models: [Partner, Order],
});

export const sale = defineKoshModule({
  shutro: saleShutro,
  kosh: '^0.1.0',
  depends: [reporting],
  accessLevels: {
    user: { label: 'User', groups: ['sale.user'] },
    manager: { label: 'Manager', groups: ['sale.manager'], implies: ['user'] },
  },
});
