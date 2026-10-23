import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { EmotionDiagnostics, localDiagnosticRequest } from './emotion-diagnostics.ts';

test('diagnostics are bounded and whitelist metadata without storing arbitrary strings', () => {
  const diagnostics = new EmotionDiagnostics(() => 1000);
  for (let i = 0; i < 100; i++)
    diagnostics.record('main', {
      category: 'event',
      event: 'praise',
      accepted: true,
      reason: 'accepted',
      after: { valence: 0.28, arousal: 0.47, label: 'cheerful' },
      ...({ prompt: 'PRIVATE PROMPT', text: 'PRIVATE CHAT', key: 'PRIVATE KEY' } as object),
    });
  const payload = diagnostics.read('main');
  assert.equal(payload.records.length, 80);
  assert.equal(payload.records[0].seq, 21);
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE|prompt|key|text/);
  payload.records[0].after!.valence = -1;
  assert.equal(diagnostics.read('main').records[0].after!.valence, 0.28);
  assert.equal(new EmotionDiagnostics().read('main').records.length, 0, 'records are not persisted');
});

test('state reads explain time decay without a model or raw event IDs', () => {
  const diagnostics = new EmotionDiagnostics(() => 1000);
  diagnostics.observe('main', { valence: 0.28, arousal: 0.47, label: 'cheerful', updatedAt: 1000 });
  diagnostics.observe('main', { valence: 0.14, arousal: 0.41, label: 'calm', updatedAt: 1801000 });
  assert.deepEqual(
    diagnostics.read('main').records.map((r) => r.event),
    ['state-loaded', 'time-decay'],
  );
});

test('diagnostic access requires an actual loopback socket and same-origin browser request', () => {
  const good = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:12345',
      referer: 'http://127.0.0.1:12345/',
      'x-dsh-pet-diagnostics': '1',
      'sec-fetch-site': 'same-origin',
    },
  };
  const allows = (request: unknown) => localDiagnosticRequest(request as IncomingMessage);
  assert.equal(allows(good), true);
  assert.equal(allows({ ...good, socket: { remoteAddress: '198.51.100.1' } }), false);
  assert.equal(allows({ ...good, socket: {} }), false);
  assert.equal(allows({ ...good, headers: { ...good.headers, host: 'evil.example' } }), false);
  assert.equal(allows({ ...good, headers: { ...good.headers, origin: 'https://evil.example' } }), false);
  assert.equal(allows({ ...good, headers: { ...good.headers, 'sec-fetch-site': 'cross-site' } }), false);
  assert.equal(allows({ ...good, headers: { ...good.headers, 'x-dsh-pet-diagnostics': undefined } }), false);
  assert.equal(allows({ ...good, headers: { ...good.headers, referer: undefined } }), false);
});

test('native DSH proxy retains strict local origin checks after it strips HTTP origin metadata', () => {
  const native = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: {
      host: '127.0.0.1:12345',
      referer: 'dsh-app://app/',
      'x-dsh-pet-diagnostics': '1',
    },
  };
  const allows = (value: unknown, verify = () => true) => localDiagnosticRequest(value as IncomingMessage, verify);
  assert.equal(allows(native), true);
  assert.equal(
    localDiagnosticRequest(native as unknown as IncomingMessage),
    false,
    'native session verification is mandatory',
  );
  assert.equal(
    allows(native, () => false),
    false,
  );
  assert.equal(
    allows(native, () => {
      throw new Error('PRIVATE AUTH ERROR');
    }),
    false,
  );
  for (const referer of [
    'dsh-app://evil/',
    'dsh-app://app.evil/',
    'dsh-app://user@app/',
    'dsh-app://app:123/',
    'dsh-app://app/path',
    'dsh-app://app/?x=1',
    'dsh-app://app/#x',
    'http://127.0.0.1:12345/',
    'null',
  ]) {
    assert.equal(allows({ ...native, headers: { ...native.headers, referer } }), false, String(referer));
  }
  for (const headers of [
    { ...native.headers, origin: 'https://evil.example' },
    { ...native.headers, origin: 'null' },
    { ...native.headers, 'sec-fetch-site': 'cross-site' },
    { ...native.headers, 'x-dsh-pet-diagnostics': undefined },
    { ...native.headers, host: 'evil.example' },
    { ...native.headers, host: '127.0.0.1:12345/path' },
  ])
    assert.equal(allows({ ...native, headers }), false);
  assert.equal(allows({ ...native, socket: { remoteAddress: '192.0.2.1' } }), false);
  const authenticated = {
    ...native,
    headers: { host: native.headers.host, 'x-dsh-pet-diagnostics': '1' },
  };
  assert.equal(allows(authenticated), true);
  assert.equal(
    allows(authenticated, () => false),
    false,
  );
  for (const headers of [
    { ...authenticated.headers, origin: 'https://evil.example' },
    { ...authenticated.headers, origin: 'null' },
    { ...authenticated.headers, 'sec-fetch-site': 'cross-site' },
    { ...authenticated.headers, 'sec-fetch-site': 'same-origin' },
    { ...authenticated.headers, referer: 'https://evil.example/' },
    { ...authenticated.headers, referer: 'null' },
    { ...authenticated.headers, 'x-dsh-pet-diagnostics': undefined },
  ])
    assert.equal(allows({ ...authenticated, headers }), false);
  assert.equal(allows({ ...authenticated, socket: { remoteAddress: '192.0.2.1' } }), false);
});
