/** A small contacts-like app for the Studio tests (the framework's tests never import a business app). */
import { defineModule } from '@kosh/modules-sdk';
import { base, baseShutro } from '@kosh/server';
import { orm } from '@kosh/server/orm';
import { form, list } from '@kosh/views';

const { defineGroup, defineModel, f } = orm;

const Partner = defineModel('res.partner', {
  recName: 'name',
  access: { 'crm.user': ['read', 'write', 'create'] },
  fields: { name: f.char({ required: true }), email: f.char(), city: f.char() },
});

export const crmShutro: ReturnType<typeof orm.defineModule> = orm.defineModule({
  name: 'crm',
  version: '0.1.0',
  depends: [baseShutro],
  groups: [defineGroup({ code: 'crm.user', label: 'CRM', implies: ['base.user'] })],
  models: [Partner],
});

export const crm: ReturnType<typeof defineModule> = defineModule({
  shutro: crmShutro,
  kosh: '^0.1.0',
  depends: [base],
  accessLevels: { user: { label: 'User', groups: ['crm.user'] } },
  views: {
    'res.partner.list': list('res.partner', { columns: ['name', 'email', 'city'] }),
    'res.partner.form': form('res.partner', (k) => ({
      sheet: [k.group('main', ['name', 'email', 'city'])],
    })),
  },
});
