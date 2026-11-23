'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const NAMES = ['SES_REGION', 'SES_CONFIGURATION_SET', 'BREVO_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'RESEND_API_KEY'];

function withEnv(values, fn) {
  const previous = Object.fromEntries(NAMES.map(name => [name, process.env[name]]));
  NAMES.forEach(name => delete process.env[name]);
  Object.assign(process.env, values);
  const restore = () => NAMES.forEach(name => {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  });
  let result;
  try { result = fn(); }
  catch (error) { restore(); throw error; }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

function fakeClient(behaviour) {
  const calls = [];
  return {
    calls,
    send: async command => {
      calls.push(command.input);
      return behaviour ? behaviour(command.input) : { MessageId: 'ses-message-1' };
    }
  };
}

const MESSAGE = {
  from: 'ISMS <noreply@nopalcyber.com>',
  to: 'person@example.com',
  subject: 'Hello',
  html: '<p>Hi</p>',
  text: 'Hi',
  replyTo: null
};

test('SES is the provider only when SES_REGION is set, and it needs no secret', () => {
  const email = require('../lib/email');
  withEnv({}, () => assert.equal(email.currentProvider(), 'devnull'));
  withEnv({ SES_REGION: 'ap-south-1' }, () => {
    assert.equal(email.sesConfigured(), true);
    assert.equal(email.currentProvider(), 'ses');
  });
});

test('other providers are unchanged when SES is not configured, and SES wins when it is', () => {
  const email = require('../lib/email');
  withEnv({ RESEND_API_KEY: 'k' }, () => assert.equal(email.currentProvider(), 'resend'));
  withEnv({ BREVO_API_KEY: 'k' }, () => assert.equal(email.currentProvider(), 'brevo'));
  withEnv({ GMAIL_USER: 'a@example.com', GMAIL_APP_PASSWORD: 'p' }, () => assert.equal(email.currentProvider(), 'gmail'));
  withEnv({ SES_REGION: 'ap-south-1', RESEND_API_KEY: 'k' }, () => assert.equal(email.currentProvider(), 'ses'));
});

test('postToSes refuses to send when SES_REGION is not set', async () => {
  const email = require('../lib/email');
  await withEnv({}, async () => {
    const client = fakeClient();
    const result = await email._postToSes(MESSAGE, client);
    assert.equal(result.ok, false);
    assert.match(result.error, /SES_REGION/);
    assert.equal(client.calls.length, 0);
  });
});

test('postToSes sends one SESv2 simple message with the right fields', async () => {
  const email = require('../lib/email');
  await withEnv({ SES_REGION: 'ap-south-1' }, async () => {
    const client = fakeClient();
    const result = await email._postToSes(MESSAGE, client);
    assert.deepEqual(result, { ok: true, id: 'ses-message-1' });
    assert.equal(client.calls.length, 1);
    const input = client.calls[0];
    assert.equal(input.FromEmailAddress, MESSAGE.from);
    assert.deepEqual(input.Destination.ToAddresses, ['person@example.com']);
    assert.equal(input.Content.Simple.Subject.Data, 'Hello');
    assert.equal(input.Content.Simple.Body.Html.Data, '<p>Hi</p>');
    assert.equal(input.Content.Simple.Body.Text.Data, 'Hi');
    assert.equal(input.Content.Simple.Body.Html.Charset, 'UTF-8');
    assert.equal(input.ReplyToAddresses, undefined);
    assert.equal(input.ConfigurationSetName, undefined);
  });
});

test('postToSes passes through several recipients, reply-to and a configuration set', async () => {
  const email = require('../lib/email');
  await withEnv({ SES_REGION: 'ap-south-1', SES_CONFIGURATION_SET: 'isms-default' }, async () => {
    const client = fakeClient();
    await email._postToSes({ ...MESSAGE, to: ['a@example.com', 'b@example.com'], replyTo: 'reply@example.com' }, client);
    const input = client.calls[0];
    assert.deepEqual(input.Destination.ToAddresses, ['a@example.com', 'b@example.com']);
    assert.deepEqual(input.ReplyToAddresses, ['reply@example.com']);
    assert.equal(input.ConfigurationSetName, 'isms-default');
  });
});

test('postToSes reports SES failures as a result instead of throwing', async () => {
  const email = require('../lib/email');
  await withEnv({ SES_REGION: 'ap-south-1' }, async () => {
    const client = fakeClient(() => { throw new Error('Email address is not verified.'); });
    const result = await email._postToSes(MESSAGE, client);
    assert.equal(result.ok, false);
    assert.match(result.error, /not verified/);
  });
});
