/**
 * What the activity log leaves out: sign-in internals, queues and logs, the chatter itself, private models, secret
 * and bulky fields — and nothing of the business records.
 */
import { expect, test } from 'vitest';
import { leftOutOfTrail } from '../src/audit-scope.js';

test('business records are logged whole: masters, documents and their lines', () => {
  for (const model of [
    'res.partner',
    'product.product',
    'sale.order',
    'sale.order.line',
    'account.move',
    'account.move.line',
    'stock.move',
    'hr.employee',
    'pos.session',
    'pos.payment.method',
    'project.task.stage',
    'mail.template',
    'mail.channel',
    'payment.transaction',
    'approval.policy',
    'res.company',
    'res.users',
  ])
    expect(leftOutOfTrail(model), model).toBe(false);
});

test('left out whole: sign-in internals, queues, deliveries and logs, the chatter, private models', () => {
  for (const model of [
    'auth.session',
    'auth.credential',
    'auth.api_key',
    'oauth.token',
    'notify.notification',
    'notify.delivery',
    'mail.message',
    'mail.follower',
    'mail.outgoing',
    'mail.inbound_message',
    'automation.run',
    'automation.cursor',
    'report.output',
    'livechat.presence',
    'livechat.message',
    'attendance.device.punch',
    'calendar.sync.link',
    'webhook.delivery',
    'delivery.shipment.event',
    'approval.event',
  ])
    expect(leftOutOfTrail(model), model).toBe(true);
  // Files, scheduled activities, approval requests and settings are business facts, though their models are
  // not served as lists of their own.
  for (const model of ['storage.attachment', 'mail.activity', 'approval.request', 'kosh.setting'])
    expect(leftOutOfTrail(model), model).toBe(false);
});

test('fields: secrets and bulky values are left out, the rest is tracked', () => {
  const out = (key: string, kind = 'char') => leftOutOfTrail('hr.employee', { key, kind });
  for (const key of ['attendancePin', 'tokenHash', 'accessSealed', 'webhookSecret', 'password'])
    expect(out(key), key).toBe(true);
  expect(out('photo', 'binary')).toBe(true);
  expect(out('layout', 'json')).toBe(true);
  expect(out('description', 'html')).toBe(true);
  for (const key of ['name', 'jobTitle', 'department', 'wage', 'shipping', 'opinion', 'note'])
    expect(out(key), key).toBe(false);
  expect(out('note', 'text')).toBe(false);
});
