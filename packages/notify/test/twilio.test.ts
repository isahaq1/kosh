/**
 * The Twilio adapter against a local HTTP server: one request per message with basic authentication and a form
 * body, the WhatsApp prefixes on both numbers, the message id from the answer, an error answer surfaced with
 * Twilio's code and message; the environment reader; phone numbers normalized to E.164.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createTwilioMessenger, messengerFromEnv, normalizePhone } from '../src/index.js';

let server: Server;
let baseUrl: string;
const requests: { url: string; authorization: string; body: string }[] = [];
let answer: { status: number; body: string } = { status: 201, body: '{"sid":"SM123"}' };

const read = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = '';
    request.on('data', (chunk) => {
      data += String(chunk);
    });
    request.on('end', () => resolve(data));
  });

beforeAll(async () => {
  server = createServer(async (request, response) => {
    requests.push({
      url: request.url ?? '',
      authorization: String(request.headers.authorization ?? ''),
      body: await read(request),
    });
    response.writeHead(answer.status, { 'content-type': 'application/json' });
    response.end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

test('phone numbers: E.164 or nothing', () => {
  expect(normalizePhone('+880 1711-000001')).toBe('+8801711000001');
  expect(normalizePhone('+1 (415) 555-0100')).toBe('+14155550100');
  expect(normalizePhone('01711000001')).toBeNull(); // no country code
  expect(normalizePhone('+12')).toBeNull();
  expect(normalizePhone('call me')).toBeNull();
});

test('an SMS and a WhatsApp message: the request, the auth, the prefixes, the id', async () => {
  const messenger = createTwilioMessenger({
    accountSid: 'ACxyz',
    authToken: 'secret',
    from: { sms: '+15550001', whatsapp: '+15550002' },
    baseUrl,
  });
  expect(messenger.channels).toEqual(['sms', 'whatsapp']);
  const sms = await messenger.send({ channel: 'sms', to: '+8801711000001', text: 'Hello' });
  expect(sms).toEqual({ id: 'SM123' });
  const [first] = requests.slice(-1);
  expect(first?.url).toBe('/2010-04-01/Accounts/ACxyz/Messages.json');
  expect(first?.authorization).toBe(`Basic ${Buffer.from('ACxyz:secret').toString('base64')}`);
  expect(new URLSearchParams(first?.body)).toEqual(
    new URLSearchParams({ To: '+8801711000001', From: '+15550001', Body: 'Hello' }),
  );
  await messenger.send({ channel: 'whatsapp', to: '+8801711000001', text: 'Hi there' });
  const [second] = requests.slice(-1);
  expect(new URLSearchParams(second?.body).get('To')).toBe('whatsapp:+8801711000001');
  expect(new URLSearchParams(second?.body).get('From')).toBe('whatsapp:+15550002');
});

test("an error answer surfaces Twilio's code and message; a channel without a sender is refused", async () => {
  const messenger = createTwilioMessenger({
    accountSid: 'ACxyz',
    authToken: 'secret',
    from: { sms: '+15550001' },
    baseUrl,
  });
  expect(messenger.channels).toEqual(['sms']);
  answer = { status: 400, body: '{"code":21211,"message":"The To number is not valid"}' };
  await expect(messenger.send({ channel: 'sms', to: '+8801711000001', text: 'x' })).rejects.toThrow(
    'Twilio answered 400: 21211 The To number is not valid',
  );
  answer = { status: 201, body: '{"sid":"SM1"}' };
  await expect(
    messenger.send({ channel: 'whatsapp', to: '+8801711000001', text: 'x' }),
  ).rejects.toThrow('no sender number for whatsapp');
});

test('the environment: nothing without an account or a sender; the channels of the senders given', () => {
  expect(messengerFromEnv({})).toBeUndefined();
  expect(messengerFromEnv({ TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' })).toBeUndefined();
  const sms = messengerFromEnv({
    TWILIO_ACCOUNT_SID: 'AC',
    TWILIO_AUTH_TOKEN: 't',
    TWILIO_SMS_FROM: '+1',
  });
  expect(sms?.channels).toEqual(['sms']);
  const both = messengerFromEnv({
    TWILIO_ACCOUNT_SID: 'AC',
    TWILIO_AUTH_TOKEN: 't',
    TWILIO_SMS_FROM: '+1',
    TWILIO_WHATSAPP_FROM: '+2',
  });
  expect(both?.channels).toEqual(['sms', 'whatsapp']);
});
