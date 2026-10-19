/** A small sales app for report tests: orders with partner, state, date, a monetary amount and a restricted margin. */
import { defineModule as defineKoshModule } from '@isahaq/kosh-modules-sdk';
import { baseShutro } from '@isahaq/kosh-server';
import { orm } from '@isahaq/kosh-server/orm';
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
  documents: [
    {
      key: 'order',
      name: 'Sales order',
      model: 'sale.order',
      layout: {
        header: '{{company.name}}',
        footer: 'Printed {{now}} · page {{page}} of {{pages}}',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Order {{name}}' },
          {
            kind: 'fields',
            id: 'main',
            items: [
              { bind: 'partner.name', label: 'Customer' },
              { bind: 'partner.city' },
              { bind: 'dateOrder' },
              { bind: 'amount' },
              { bind: 'state' },
            ],
          },
          { kind: 'signature', id: 'sign', labels: ['Prepared by', 'Approved by'] },
        ],
      },
    },
    {
      key: 'orders',
      name: 'Order list',
      model: 'sale.order',
      scope: 'list',
      layout: {
        orientation: 'landscape',
        blocks: [
          { kind: 'heading', id: 'title', text: 'Orders' },
          {
            kind: 'table',
            id: 'orders',
            bind: '$records',
            columns: [
              { bind: 'name' },
              { bind: 'partner.name', label: 'Customer' },
              { bind: 'dateOrder' },
              { bind: 'amount', sum: true },
            ],
          },
        ],
      },
    },
  ],
});
