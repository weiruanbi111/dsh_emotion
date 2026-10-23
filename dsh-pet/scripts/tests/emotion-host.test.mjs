/**
 * Built-host integration regression. Prerequisite: npm run build.
 * Run: node --test scripts/tests/emotion-host.test.mjs
 * Uses a workspace-only DSH_HOME and an in-process model stub; no credentials or Electron.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';

import { apply } from '../../lib/index.js';

const ROOT = resolve(import.meta.dirname, '../..');
const PREFIX = '/dsh-pet-7340';
const LOCAL_DIAGNOSTIC_REQUEST = {
  socket: { remoteAddress: '127.0.0.1' },
  headers: {
    host: '127.0.0.1:12345',
    'x-dsh-pet-diagnostics': '1',
    'sec-fetch-site': 'same-origin',
    referer: 'http://127.0.0.1:12345/',
  },
};
const PET = {
  id: 'main',
  name: '情绪测试',
  size: 462,
  display: 'web',
  balanceEnabled: false,
  whisperEnabled: true,
  workStatusEnabled: true,
  fixedEnabled: true,
  position: { corner: 'bottom-right', marginX: 0, marginY: 0 },
};

class Response extends Writable {
  status = 0;
  chunks = [];
  writeHead(status) {
    this.status = status;
    return this;
  }
  _write(chunk, _encoding, done) {
    this.chunks.push(Buffer.from(chunk));
    done();
  }
}

function harness(t, overlay = {}) {
  const directory = mkdtempSync(join(ROOT, '.emotion-host-test-'));
  const userRoot = join(directory, 'dsh-pet');
  const configPath = join(userRoot, 'main-config.jsonc');
  mkdirSync(userRoot);
  const savedHome = process.env.DSH_HOME;
  const savedElectron = process.env.DSH_PET_ELECTRON_PATH;
  process.env.DSH_HOME = directory;
  process.env.DSH_PET_ELECTRON_PATH = process.execPath;
  let config = {
    emotionEnabled: true,
    doNotDisturb: false,
    notificationsEnabled: false,
    whisperImageEnabled: false,
    chatImageEnabled: false,
    pets: [PET],
    ...overlay,
  };
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const disposers = [];
  const listeners = [];
  const calls = [];
  let route;
  let whisperEffect;
  let answer = '你好呀';
  let hold;
  let modelFailure;
  const startHost = () =>
    apply({
      provide: () => () => {},
      effect(fn, name) {
        if (name === 'dsh-pet: balance poll') return () => {};
        if (name === 'dsh-pet: whisper poll') {
          whisperEffect = fn;
          return () => {};
        }
        const disposer = fn();
        if (typeof disposer === 'function') disposers.push(disposer);
        return disposer;
      },
      on(name, listener) {
        if (name === 'session/event') listeners.push(listener);
        return () => {};
      },
      webServer: {
        port: 0,
        register(spec) {
          route = spec.handler;
          return () => {};
        },
      },
      commands: { register: () => () => {} },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      agentDefaultModel: { currentSelection: () => ({ provider: 'no-network-test-provider', model: 'test-chat' }) },
      credentials: { resolve: async () => undefined },
      connection: { requestRejection: (req) => (req.headers['x-fixture-authenticated'] === 'yes' ? undefined : 401) },
      llm: {
        resolveModelInfo: async () => ({}),
        stream(options) {
          calls.push(options);
          const waiting = hold;
          const text = answer;
          const failure = modelFailure;
          return (async function* () {
            if (waiting) await waiting;
            if (failure) throw new Error(failure);
            yield { type: 'text-delta', index: 0, text };
          })();
        },
      },
    });
  const stopHost = () => {
    for (const disposer of disposers.splice(0).reverse()) disposer();
    listeners.splice(0);
  };
  t.after(() => {
    stopHost();
    if (savedHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedHome;
    if (savedElectron === undefined) delete process.env.DSH_PET_ELECTRON_PATH;
    else process.env.DSH_PET_ELECTRON_PATH = savedElectron;
    assert.ok(resolve(directory).startsWith(join(ROOT, '.emotion-host-test-')));
    rmSync(directory, { recursive: true, force: true });
  });
  startHost();
  assert.equal(typeof route, 'function');
  assert.equal(typeof whisperEffect, 'function');
  const call = (path, method = 'GET', body, metadata = LOCAL_DIAGNOSTIC_REQUEST) =>
    new Promise((done, reject) => {
      const res = new Response();
      res.on('finish', () => {
        const text = Buffer.concat(res.chunks).toString('utf8');
        done({ status: res.status, body: text ? JSON.parse(text) : null });
      });
      const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      Promise.resolve(
        route(
          {
            method,
            url: PREFIX + path,
            headers: metadata.headers,
            socket: metadata.socket,
            on(event, callback) {
              if (event === 'data' && bytes !== undefined) queueMicrotask(() => callback(bytes));
              if (event === 'end') queueMicrotask(callback);
              return this;
            },
          },
          res,
        ),
      ).catch(reject);
    });
  return {
    call,
    calls,
    userRoot,
    state: async () => (await call('/state')).body,
    emotion: async () => {
      const result = await call('/emotion?pet=main');
      assert.equal(result.status, 200);
      return result.body;
    },
    diagnostics: async () => {
      const result = await call('/emotion?pet=main&diagnostics=1');
      assert.equal(result.status, 200);
      return result.body;
    },
    chat: async (text) => {
      const result = await call('/chat?pet=main', 'POST', { text });
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      return result;
    },
    emit: (sessionId, event) => {
      for (const listener of listeners) listener({ header: { id: sessionId } }, event);
    },
    async tick() {
      disposers.push(whisperEffect());
      await new Promise(setImmediate);
    },
    advance(ms) {
      now += ms;
    },
    reply(text) {
      answer = text;
    },
    fail(message) {
      modelFailure = message;
    },
    hold(promise) {
      hold = promise;
    },
    updateRaw(patch) {
      config = { ...config, ...patch };
      writeFileSync(configPath, JSON.stringify(config), 'utf8');
    },
    restart() {
      stopHost();
      startHost();
    },
  };
}

test('built host exposes inspect/reset and injects explicit praise with an existing animation', async (t) => {
  const h = harness(t);
  const initial = await h.emotion();
  assert.equal(initial.enabled, true);
  assert.equal(initial.state.label, 'calm');
  await h.chat('你真棒！');
  const happy = await h.emotion();
  assert.equal(happy.state.label, 'cheerful');
  assert.match(h.calls.at(-1).system, /用户明确夸奖桌宠/);
  assert.match(h.calls.at(-1).system, /桌宠自身的模拟状态/);
  assert.match(h.calls.at(-1).system, /不能证明任务产出的真实质量/);
  const config = (await h.call('/config')).body.main;
  assert.equal((await h.state()).pets.main.say.data.emotionAnimation, config.animations.events.workStatus[4]);
  await h.chat('你真棒！');
  assert.equal((await h.emotion()).state.valence, happy.state.valence, 'duplicate compliment delivery is deduplicated');
  assert.equal((await h.call('/emotion/reset?pet=main', 'POST')).body.ok, true);
  assert.equal((await h.emotion()).state.valence, 0);
  assert.equal((await h.call('/emotion?pet=missing')).status, 400);
});

test('assistant claims about task success never become observed emotion events', async (t) => {
  const h = harness(t);
  h.reply('任务已经全部完成，而且用户现在非常开心！');
  await h.chat('请继续');
  assert.equal((await h.emotion()).state.valence, 0);
  assert.match(h.calls[0].system, /不虚构用户/);
});

test('a neutral greeting is not classified as praise', async (t) => {
  const h = harness(t);
  await h.chat('你好');
  assert.equal((await h.emotion()).state.valence, 0);
  assert.match(h.calls[0].system, /明确事件：尚无/);
});

test('host execution success/failure uses real sequence IDs and deduplicates repeated events', async (t) => {
  const h = harness(t);
  const end = { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } };
  h.emit('task-a', end);
  const success = (await h.emotion()).state.valence;
  assert.ok(success > 0);
  h.emit('task-a', end);
  assert.equal((await h.emotion()).state.valence, success);
  h.emit('task-a', { type: 'turn/end', seq: 4, data: { reason: { kind: 'error' } } });
  const failure = (await h.emotion()).state.valence;
  assert.ok(failure < success);
  h.emit('task-a', { type: 'turn/end', data: { reason: { kind: 'completed' } } });
  h.emit('unknown', { type: 'turn/end', seq: 100, data: { reason: { kind: 'completed' } } });
  assert.equal((await h.emotion()).state.valence, failure);
});

test('goal intermediate rounds, goal blocked completion, and approval waiting do not imply failure', async (t) => {
  const h = harness(t);
  h.emit('goal', { type: 'turn/start', seq: 1 });
  h.emit('goal', { type: 'user/message', seq: 2, data: { source: { kind: 'goal' } } });
  h.emit('goal', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } });
  assert.equal((await h.emotion()).state.valence, 0);
  h.emit('goal', { type: 'turn/start', seq: 4 });
  h.emit('goal', { type: 'user/message', seq: 5, data: { source: { kind: 'goal' } } });
  h.emit('goal', { type: 'tool/call', seq: 6, data: { name: 'update_goal', arguments: '{"action":"blocked"}' } });
  h.emit('goal', { type: 'turn/end', seq: 7, data: { reason: { kind: 'completed' } } });
  assert.equal((await h.emotion()).state.valence, 0);
  h.emit('goal', { type: 'approval/asked', seq: 8 });
  h.emit('goal', { type: 'turn/end', seq: 9, data: { reason: { kind: 'blocked' } } });
  assert.equal((await h.emotion()).state.valence, 0);
});

test('quiet mode blocks automatic interaction while manual chat and whisper remain available', async (t) => {
  const h = harness(t, { doNotDisturb: true });
  await h.tick();
  assert.equal(h.calls.length, 0);
  const quiet = await h.emotion();
  assert.equal(quiet.doNotDisturb, true);
  assert.equal(quiet.state.valence, 0, 'quiet mode does not punish the user');
  assert.ok(quiet.state.arousal < 0.35);
  await h.chat('你好');
  assert.match(h.calls.at(-1).system, /用户已开启勿扰/);
  assert.equal((await h.call('/whisper?pet=main', 'POST')).body.ok, true);
});

test('leaving quiet mode restores an unchanged active work status after its overlay was cleared', async (t) => {
  const h = harness(t);
  h.emit('task', { type: 'turn/start', seq: 1 });
  h.emit('task', { type: 'tool/call', seq: 2, data: { name: 'read' } });
  assert.equal((await h.state()).sections.workStatus.data.state, 'working');
  const current = (await h.call('/config')).body.main;
  assert.equal((await h.call('/config', 'PUT', { ...current, doNotDisturb: true })).status, 200);
  const quiet = (await h.state()).sections.workStatus;
  assert.equal(quiet.data.state, null);
  assert.equal((await h.call('/config', 'PUT', { ...current, doNotDisturb: false })).status, 200);
  const restored = (await h.state()).sections.workStatus;
  assert.equal(restored.data.state, 'working');
  assert.ok(restored.counter > quiet.counter);
  await h.call('/config', 'PUT', { ...current, doNotDisturb: true });
  assert.equal((await h.state()).sections.workStatus.data.state, null);
  assert.equal((await h.call('/config', 'POST')).status, 200);
  assert.equal((await h.state()).sections.workStatus.data.state, 'working', 'restoring defaults also exits quiet mode');
});

test('automatic cooldown spans manual chat and reset, and prevents duplicate generation', async (t) => {
  const h = harness(t);
  await h.tick();
  assert.equal(h.calls.length, 1);
  await h.tick();
  assert.equal(h.calls.length, 1);
  h.advance(300000);
  await h.chat('你好');
  assert.equal(h.calls.length, 2);
  await h.call('/emotion/reset?pet=main', 'POST');
  await h.tick();
  assert.equal(h.calls.length, 2);
  h.advance(300000);
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.equal(JSON.parse(readFileSync(join(h.userRoot, 'emotion.json'), 'utf8')).version, 1);
});

test('an automatic result started before quiet mode is discarded after the policy change', async (t) => {
  const h = harness(t);
  let release;
  h.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await h.tick();
  assert.equal(h.calls.length, 1);
  const current = (await h.call('/config')).body.main;
  const saved = await h.call('/config', 'PUT', { ...current, doNotDisturb: true });
  assert.equal(saved.status, 200);
  release();
  await new Promise(setImmediate);
  assert.equal((await h.state()).pets.main?.say?.data ?? null, null);
});

test('an automatic result is discarded when a real work turn starts during generation', async (t) => {
  const h = harness(t);
  let release;
  h.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await h.tick();
  assert.equal(h.calls.length, 1);
  h.emit('new-work', { type: 'turn/start', seq: 1 });
  release();
  await new Promise(setImmediate);
  const state = await h.state();
  assert.equal(state.sections.workStatus.data.state, 'thinking');
  assert.equal(state.pets.main?.say?.data ?? null, null);
});

test('an automatic result is discarded when automatic speech is disabled during generation', async (t) => {
  const h = harness(t);
  let release;
  h.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await h.tick();
  assert.equal(h.calls.length, 1);
  const current = (await h.call('/config')).body.main;
  const saved = await h.call('/config', 'PUT', {
    ...current,
    pets: current.pets.map((pet) => ({ ...pet, whisperEnabled: false })),
  });
  assert.equal(saved.status, 200);
  release();
  await new Promise(setImmediate);
  assert.equal((await h.state()).pets.main?.say?.data ?? null, null);
});

test('feature off preserves normal chat and skips emotional context and observations', async (t) => {
  const h = harness(t, { emotionEnabled: false });
  await h.chat('你真棒！');
  h.emit('task', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } });
  const state = await h.emotion();
  assert.equal(state.enabled, false);
  assert.equal(state.state.valence, 0);
  assert.doesNotMatch(h.calls[0].system, /桌宠情绪上下文/);
  assert.equal(Object.hasOwn((await h.state()).pets.main.say.data, 'emotionAnimation'), false);
});

test('missing emotion animation keeps the reply text and provides a text-only animation signal', async (t) => {
  const h = harness(t, {
    animations: {
      idle: ['existing-idle'],
      turn: [],
      drag: [],
      clicks: [],
      moves: { default: {}, actions: [] },
      categories: [],
      events: { balance: ['existing-balance'] },
    },
  });
  await h.chat('你真棒！');
  const say = (await h.state()).pets.main.say.data;
  assert.equal(say.text, '你好呀');
  assert.equal(say.emotionAnimation, null);
});

test('diagnostic details require explicit same-origin loopback access while the ordinary query stays compatible', async (t) => {
  const h = harness(t);
  const headers = LOCAL_DIAGNOSTIC_REQUEST.headers;
  const denied = [
    {},
    { headers, socket: { remoteAddress: '192.0.2.10' } },
    { headers: { ...headers, 'x-dsh-pet-diagnostics': undefined }, socket: LOCAL_DIAGNOSTIC_REQUEST.socket },
    { headers: { ...headers, 'sec-fetch-site': 'cross-site' }, socket: LOCAL_DIAGNOSTIC_REQUEST.socket },
    { headers: { ...headers, referer: 'https://example.invalid/' }, socket: LOCAL_DIAGNOSTIC_REQUEST.socket },
    { headers: { ...headers, origin: 'https://example.invalid' }, socket: LOCAL_DIAGNOSTIC_REQUEST.socket },
  ];
  for (const metadata of denied) {
    const result = await h.call('/emotion?pet=main&diagnostics=1', 'GET', undefined, metadata);
    assert.equal(result.status, 403);
    assert.equal(Object.hasOwn(result.body, 'diagnostics'), false);
  }
  const ordinary = await h.call('/emotion?pet=main', 'GET', undefined, {});
  assert.equal(ordinary.status, 200);
  assert.equal(Object.hasOwn(ordinary.body, 'diagnostics'), false);
  const detailed = await h.diagnostics();
  assert.equal(typeof detailed.build.id, 'string');
  assert.ok(detailed.build.id.length > 0);
  assert.equal(typeof detailed.build.version, 'string');
  assert.equal(detailed.diagnostics.capacity, 80);
  assert.equal(detailed.diagnostics.lifetime, 'process');
  const nativeHeaders = {
    host: headers.host,
    referer: 'dsh-app://app/',
    'x-dsh-pet-diagnostics': '1',
    'x-fixture-authenticated': 'yes',
  };
  const native = await h.call('/emotion?pet=main&diagnostics=1', 'GET', undefined, {
    headers: nativeHeaders,
    socket: LOCAL_DIAGNOSTIC_REQUEST.socket,
  });
  assert.equal(native.status, 200, 'owned native proxy metadata is supported');
  assert.equal(native.body.build.id, 'emotion-mvp1.1-20261023.3');
  assert.equal(native.body.build.version, '0.3.7-emotion.1.1.2');
  const marker = { host: headers.host, 'x-dsh-pet-diagnostics': '1', 'x-fixture-authenticated': 'yes' };
  assert.equal(
    (
      await h.call('/emotion?pet=main&diagnostics=1', 'GET', undefined, {
        headers: marker,
        socket: LOCAL_DIAGNOSTIC_REQUEST.socket,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await h.call('/emotion?pet=main&diagnostics=1', 'GET', undefined, {
        headers: { ...marker, origin: 'https://evil.example' },
        socket: LOCAL_DIAGNOSTIC_REQUEST.socket,
      })
    ).status,
    403,
  );
  for (const bad of [
    { ...nativeHeaders, referer: 'dsh-app://evil/' },
    { ...nativeHeaders, origin: 'https://evil.example' },
    { ...nativeHeaders, 'sec-fetch-site': 'cross-site' },
    { ...nativeHeaders, 'x-fixture-authenticated': undefined },
    { ...marker, 'x-fixture-authenticated': undefined },
  ])
    assert.equal(
      (
        await h.call('/emotion?pet=main&diagnostics=1', 'GET', undefined, {
          headers: bad,
          socket: LOCAL_DIAGNOSTIC_REQUEST.socket,
        })
      ).status,
      403,
    );
  assert.equal(h.calls.length, 0, 'inspecting diagnostic state cannot call a model');
});

test('diagnostic records have a bounded allowlisted shape and never copy chat, output, persona, or source identity', async (t) => {
  const secrets = {
    persona: 'fixture-persona-secret-36d4',
    chat: 'fixture-user-private-480a',
    output: 'fixture-output-private-b6f1',
    session: 'fixture-session-private-a4c9',
    failure: 'fixture-provider-secret-23f8',
  };
  const h = harness(t, { whisperPrompt: secrets.persona });
  h.reply(secrets.output);
  await h.chat(secrets.chat);
  const event = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } };
  h.emit(secrets.session, event);
  h.emit(secrets.session, event);
  const observed = await h.diagnostics();
  assert.ok(observed.diagnostics.records.some((row) => row.category === 'event' && row.accepted === true));
  assert.ok(observed.diagnostics.records.some((row) => row.category === 'event' && row.accepted === false));
  assert.ok(
    observed.diagnostics.records.some((row) => row.category === 'expression' && typeof row.strategy === 'string'),
  );
  const beforeReads = observed.diagnostics.records;
  const callsBeforeReads = h.calls.length;
  const afterReads = await h.diagnostics();
  assert.deepEqual(afterReads.diagnostics.records, beforeReads, 'read-only inspection must not fill its own history');
  assert.equal(h.calls.length, callsBeforeReads);
  h.fail(secrets.failure);
  const failed = await h.call('/chat?pet=main', 'POST', { text: secrets.chat });
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.reason, 'generate-error');
  const failedDiagnostics = await h.diagnostics();
  for (let seq = 2; seq <= 120; seq++) {
    h.emit(secrets.session, { ...event, seq });
  }
  const detailed = await h.diagnostics();
  assert.equal(detailed.diagnostics.records.length, 80);
  const allowed = new Set([
    'seq',
    'ts',
    'category',
    'event',
    'accepted',
    'reason',
    'before',
    'after',
    'strategy',
    'animation',
  ]);
  let lastSequence = 0;
  for (const row of detailed.diagnostics.records) {
    assert.ok(
      Object.keys(row).every((key) => allowed.has(key)),
      'diagnostics must keep an explicit field allowlist',
    );
    assert.ok(Number.isSafeInteger(row.seq) && row.seq > lastSequence);
    lastSequence = row.seq;
    assert.ok(Number.isFinite(row.ts));
    assert.ok(['event', 'expression', 'proactive', 'lifecycle'].includes(row.category));
    assert.equal(typeof row.event, 'string');
    assert.equal(typeof row.accepted, 'boolean');
    assert.equal(typeof row.reason, 'string');
    for (const state of [row.before, row.after].filter(Boolean)) {
      assert.ok(state.valence >= -1 && state.valence <= 1);
      assert.ok(state.arousal >= 0 && state.arousal <= 1);
      assert.ok(['calm', 'cheerful', 'subdued'].includes(state.label));
      assert.ok(Object.keys(state).every((key) => ['valence', 'arousal', 'label'].includes(key)));
    }
  }
  const serialized = JSON.stringify([observed.diagnostics, failedDiagnostics.diagnostics, detailed.diagnostics]);
  for (const value of Object.values(secrets)) assert.ok(!serialized.includes(value));
  assert.doesNotMatch(serialized, /whisperPrompt|messages|content|system|apiKey|authorization/i);
});

function scenarioEvidence(t, fixture, measurements = {}) {
  // Safe three-column evidence: fixture names, numeric states and enums only; no prompts or model text.
  t.diagnostic(
    JSON.stringify({
      fixture,
      program: 'passed',
      modelQuality: 'not-verified',
      realWindow: 'not-verified',
      ...measurements,
    }),
  );
}

test('nine reproducible experience fixtures keep program, model quality and window evidence separate', async (t) => {
  await t.test('ordinary-greeting', async (t) => {
    const h = harness(t);
    await h.chat('你好');
    const state = (await h.emotion()).state;
    assert.equal(state.valence, 0);
    assert.equal(state.label, 'calm');
    scenarioEvidence(t, 'ordinary-greeting', { valence: state.valence, label: state.label });
  });

  await t.test('direct-praise', async (t) => {
    const h = harness(t);
    await h.chat('你真棒！');
    const first = (await h.emotion()).state;
    await h.chat('你真棒！');
    const repeated = (await h.emotion()).state;
    assert.ok(first.valence > 0 && first.valence < 1);
    assert.equal(repeated.valence, first.valence);
    const detailed = await h.diagnostics();
    assert.ok(detailed.diagnostics.records.some((row) => row.event === 'praise' && row.accepted === true));
    assert.ok(detailed.diagnostics.records.some((row) => row.event === 'praise' && row.reason === 'duplicate-event'));
    scenarioEvidence(t, 'direct-praise', { valence: first.valence, repeatedValence: repeated.valence });
  });

  await t.test('quoted-praise', async (t) => {
    const h = harness(t);
    await h.chat('“你真棒”是什么意思');
    await h.chat('他夸你真棒');
    const state = (await h.emotion()).state;
    assert.equal(state.valence, 0);
    const detailed = await h.diagnostics();
    assert.ok(
      detailed.diagnostics.records.some((row) => row.event === 'user-message' && row.reason === 'not-direct-praise'),
    );
    scenarioEvidence(t, 'quoted-praise', { valence: state.valence });
  });

  await t.test('technical-question-after-praise', async (t) => {
    const persona = '你是保留人设的蓝色桌宠，爱玩魔方，温柔俏皮；日常短短一句，20字以内。';
    const h = harness(t, { whisperPrompt: persona });
    await h.chat('你真棒！');
    const first = (await h.emotion()).state;
    const technical = '请解释 async/await 与 Promise 的错误处理，分别给出完整示例。';
    await h.chat(technical);
    const current = (await h.emotion()).state;
    assert.equal(current.valence, first.valence, 'a technical question is not an additional compliment');
    assert.ok(JSON.stringify(h.calls.at(-1).messages.at(-1)).includes(technical));
    const system = h.calls.at(-1).system;
    assert.ok(system.startsWith('[固定人设]\n' + persona + '\n'), 'the configured persona stays intact');
    assert.match(system, /准确、完整地回应当前问题优先/);
    assert.match(system, /20字以内.*仅适用于日常碎碎念.*不限制技术解答/u);
    assert.match(system, /没有收到代码或具体报错内容时.*不得声称已经看过、理解或修复/u);
    assert.match(system, /宿主回合完成只表示一次执行结束，不等于产出正确、任务成功或用户认可/u);
    const details = (await h.diagnostics()).diagnostics.records.filter(
      (row) => row.category === 'expression' && row.event === 'chat',
    );
    const planned = details.findLast((row) => row.reason === 'planned');
    const published = details.findLast((row) => row.reason === 'published');
    const config = (await h.call('/config')).body.main;
    assert.equal(planned.strategy, 'technical');
    assert.equal(published.strategy, 'technical');
    assert.equal(planned.animation, config.animations.idle[0]);
    assert.equal(published.animation, config.animations.idle[0]);
    assert.equal((await h.state()).pets.main.say.data.emotionAnimation, config.animations.idle[0]);
    scenarioEvidence(t, 'technical-question-after-praise', {
      valence: current.valence,
      label: current.label,
      strategy: published.strategy,
      animationMode: 'idle',
    });
  });

  await t.test('consecutive-host-completed', async (t) => {
    const h = harness(t);
    const states = [];
    for (let seq = 1; seq <= 8; seq++) {
      h.emit('fixture-completed', { type: 'turn/end', seq, data: { reason: { kind: 'completed' } } });
      states.push((await h.emotion()).state);
      h.advance(1000);
    }
    assert.ok(states.every((state) => state.valence >= 0 && state.valence <= 0.24 && state.arousal <= 0.47));
    const detailed = await h.diagnostics();
    const completed = detailed.diagnostics.records.filter((row) => row.event === 'host-turn-completed');
    assert.equal(completed.filter((row) => row.accepted).length, 3);
    assert.equal(completed.filter((row) => row.reason === 'session-completion-limit').length, 5);
    const beforeDuplicate = (await h.emotion()).state;
    h.emit('fixture-completed', { type: 'turn/end', seq: 8, data: { reason: { kind: 'completed' } } });
    assert.deepEqual((await h.emotion()).state, beforeDuplicate);
    const duplicate = (await h.diagnostics()).diagnostics.records.at(-1);
    assert.equal(duplicate.event, 'host-turn-completed');
    assert.equal(duplicate.reason, 'duplicate-event');
    scenarioEvidence(t, 'consecutive-host-completed', {
      valences: states.map((state) => state.valence),
      arousals: states.map((state) => state.arousal),
      acceptedCount: completed.filter((row) => row.accepted).length,
      limitedCount: completed.filter((row) => row.reason === 'session-completion-limit').length,
    });
  });

  await t.test('failure-then-retry', async (t) => {
    const h = harness(t);
    h.emit('fixture-retry', { type: 'turn/end', seq: 1, data: { reason: { kind: 'error' } } });
    const failed = (await h.emotion()).state;
    assert.ok(failed.valence < 0);
    h.emit('fixture-retry', { type: 'turn/start', seq: 2 });
    h.emit('fixture-retry', { type: 'tool/call', seq: 3, data: { name: 'read' } });
    assert.equal((await h.state()).sections.workStatus.data.state, 'working');
    await h.chat('刚刚失败了，我准备重试，还没有给你代码和报错。');
    const plan = (await h.diagnostics()).diagnostics.records.findLast(
      (row) => row.category === 'expression' && row.reason === 'published',
    );
    assert.equal(plan.strategy, 'supportive-chat');
    const config = (await h.call('/config')).body.main;
    assert.equal(plan.animation, config.animations.idle[0]);
    assert.equal((await h.state()).pets.main.say.data.emotionAnimation, config.animations.idle[0]);
    h.emit('fixture-retry', { type: 'turn/end', seq: 4, data: { reason: { kind: 'completed' } } });
    const ended = (await h.emotion()).state;
    assert.ok(ended.valence > failed.valence);
    scenarioEvidence(t, 'failure-then-retry', {
      failedValence: failed.valence,
      endedValence: ended.valence,
      label: ended.label,
      strategy: plan.strategy,
      animationMode: 'idle',
    });
  });

  await t.test('quiet-mode-during-generation', async (t) => {
    const h = harness(t);
    let release;
    h.hold(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await h.tick();
    const current = (await h.call('/config')).body.main;
    await h.call('/config', 'PUT', { ...current, doNotDisturb: true });
    release();
    await new Promise(setImmediate);
    assert.equal(h.calls.length, 1);
    assert.equal((await h.state()).pets.main?.say?.data ?? null, null);
    const detailed = await h.diagnostics();
    assert.ok(
      detailed.diagnostics.records.some(
        (row) => row.category === 'proactive' && row.accepted === false && row.reason === 'quiet-mode',
      ),
    );
    scenarioEvidence(t, 'quiet-mode-during-generation', { modelStubCalls: h.calls.length, submitted: false });
  });

  await t.test('restart', async (t) => {
    const h = harness(t);
    await h.chat('你真棒！');
    const before = (await h.emotion()).state;
    h.restart();
    assert.deepEqual((await h.emotion()).state, before);
    const restarted = await h.diagnostics();
    assert.equal(
      restarted.diagnostics.records.length,
      1,
      'process-local diagnostics begin again instead of becoming long-term memory',
    );
    assert.equal(restarted.diagnostics.records[0].event, 'state-loaded');
    assert.equal(restarted.diagnostics.records[0].seq, 1);
    await h.chat('你真棒！');
    assert.equal((await h.emotion()).state.valence, before.valence);
    const callCount = h.calls.length;
    await h.tick();
    assert.equal(h.calls.length, callCount, 'restart must not bypass manual interaction cooldown');
    const detailed = await h.diagnostics();
    assert.equal(detailed.diagnostics.lifetime, 'process');
    scenarioEvidence(t, 'restart', { valence: before.valence, automaticCallsAfterRestart: h.calls.length - callCount });
  });

  await t.test('decay', async (t) => {
    const h = harness(t);
    await h.chat('你真棒！');
    const first = (await h.emotion()).state;
    const callCount = h.calls.length;
    h.advance(30 * 60 * 1000);
    const half = (await h.emotion()).state;
    assert.ok(Math.abs(half.valence - first.valence / 2) < 1e-12);
    assert.ok(Math.abs(half.arousal - (0.35 + (first.arousal - 0.35) / 2)) < 1e-12);
    assert.equal(h.calls.length, callCount, 'time passing alone does not generate speech or a negative event');
    scenarioEvidence(t, 'decay', {
      initialValence: first.valence,
      halfHourValence: half.valence,
      modelStubCalls: h.calls.length,
    });
  });
});

test('a failure after repeated completed turns returns to a calm mood instead of retaining saturated cheerfulness', async (t) => {
  const h = harness(t);
  for (let seq = 1; seq <= 8; seq++) {
    h.emit('fixture-capped-then-error', { type: 'turn/end', seq, data: { reason: { kind: 'completed' } } });
  }
  const before = (await h.emotion()).state;
  assert.ok(Math.abs(before.valence - 0.24) < 1e-12);
  h.emit('fixture-capped-then-error', { type: 'turn/end', seq: 9, data: { reason: { kind: 'error' } } });
  const after = (await h.emotion()).state;
  assert.ok(Math.abs(after.valence - 0.02) < 1e-12);
  assert.equal(after.label, 'calm');
  const failed = (await h.diagnostics()).diagnostics.records.at(-1);
  assert.equal(failed.event, 'host-execution-failed');
  assert.equal(failed.accepted, true);
  scenarioEvidence(t, 'failure-after-completion-ceiling', {
    beforeValence: before.valence,
    afterValence: after.valence,
    label: after.label,
  });
});

test('a host completion ceiling survives restart and remembers ignored transport IDs after its window expires', async (t) => {
  const h = harness(t);
  const complete = (seq) =>
    h.emit('fixture-completion-restart', { type: 'turn/end', seq, data: { reason: { kind: 'completed' } } });
  for (let seq = 1; seq <= 4; seq++) complete(seq);
  const capped = (await h.emotion()).state;
  h.restart();
  complete(5);
  assert.equal((await h.emotion()).state.valence, capped.valence);
  const limited = (await h.diagnostics()).diagnostics.records.at(-1);
  assert.equal(limited.reason, 'session-completion-limit');
  h.advance(10 * 60 * 1000);
  const decayed = (await h.emotion()).state;
  complete(4);
  assert.equal(
    (await h.emotion()).state.valence,
    decayed.valence,
    'an ignored old event cannot gain credit after expiry',
  );
  const replay = (await h.diagnostics()).diagnostics.records.at(-1);
  assert.equal(replay.reason, 'duplicate-event');
  complete(6);
  const renewed = (await h.emotion()).state;
  assert.ok(Math.abs(renewed.valence - (decayed.valence + 0.08)) < 1e-12);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'accepted');
  scenarioEvidence(t, 'completion-ceiling-restart', {
    cappedValence: capped.valence,
    decayedValence: decayed.valence,
    renewedValence: renewed.valence,
  });
});

test('a current failure selects support and a neutral animation even while praise keeps the underlying mood cheerful', async (t) => {
  const persona = '你是蓝色桌宠，爱玩魔方，温柔俏皮。';
  const h = harness(t, { whisperPrompt: persona });
  await h.chat('你真棒！');
  await h.chat('你太可爱了');
  const happy = (await h.emotion()).state;
  assert.ok(Math.abs(happy.valence - 0.56) < 1e-12);
  h.emit('fixture-cheerful-error', { type: 'turn/end', seq: 1, data: { reason: { kind: 'error' } } });
  const failed = (await h.emotion()).state;
  assert.equal(failed.label, 'cheerful', 'the continuous mood need not be erased for a single error');
  await h.chat('刚刚失败了，我准备重试，还没有给你代码和报错。');
  const current = (await h.emotion()).state;
  assert.equal(current.valence, failed.valence);
  const system = h.calls.at(-1).system;
  assert.ok(system.startsWith('[固定人设]\n' + persona + '\n'));
  assert.match(system, /当前宿主上报了执行错误.*避免轻快庆祝/u);
  assert.match(system, /没有收到代码或具体报错内容时.*不得声称已经看过、理解或修复/u);
  const expression = (await h.diagnostics()).diagnostics.records.findLast(
    (row) => row.category === 'expression' && row.reason === 'published',
  );
  const config = (await h.call('/config')).body.main;
  assert.equal(expression.strategy, 'supportive-chat');
  assert.equal(expression.animation, config.animations.idle[0]);
  assert.equal((await h.state()).pets.main.say.data.emotionAnimation, config.animations.idle[0]);
  assert.notEqual(expression.animation, config.animations.events.workStatus[4]);
  scenarioEvidence(t, 'current-error-overrides-cheerful-mood', {
    valence: current.valence,
    label: current.label,
    strategy: expression.strategy,
    animationMode: 'idle',
  });
});

test('automatic content repetition is distinct from event duplication and does not publish or retry after cooldown', async (t) => {
  const h = harness(t);
  h.reply('安静陪你。');
  await h.tick();
  const first = (await h.state()).pets.main.say;
  assert.equal(h.calls.length, 1);
  h.advance(300000);
  h.reply(' 安 静，陪 你！');
  await h.tick();
  assert.equal(h.calls.length, 2, 'one scheduled request, without a retry to force different content');
  assert.deepEqual((await h.state()).pets.main.say, first, 'normalized repetition cannot update the speech counter');
  const repeated = (await h.diagnostics()).diagnostics.records.at(-1);
  assert.equal(repeated.category, 'proactive');
  assert.equal(repeated.event, 'automatic-whisper');
  assert.equal(repeated.reason, 'content-repeat');
  assert.equal(repeated.accepted, false);
  const end = { type: 'turn/end', seq: 1, data: { reason: { kind: 'completed' } } };
  h.emit('fixture-independent-event', end);
  h.emit('fixture-independent-event', end);
  const duplicateEvent = (await h.diagnostics()).diagnostics.records.at(-1);
  assert.equal(duplicateEvent.category, 'event');
  assert.equal(duplicateEvent.reason, 'duplicate-event');
  await h.tick();
  assert.equal(h.calls.length, 2, 'a dropped repeated line still consumes the reserved cooldown');
  h.advance(300000);
  h.reply('换个姿势歇一会儿。');
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.ok((await h.state()).pets.main.say.counter > first.counter);
  const raw = readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8');
  assert.ok(!raw.includes('安静陪你') && !raw.includes('换个姿势'));
  assert.equal(JSON.parse(raw).pets[0].entries.length, 2);
  scenarioEvidence(t, 'automatic-content-repeat', {
    modelStubCalls: h.calls.length,
    suppressedCount: 1,
    contentReason: repeated.reason,
    eventReason: duplicateEvent.reason,
  });
});

test('automatic punctuation-only content is silently discarded without retries or remembering an empty fingerprint', async (t) => {
  const h = harness(t);
  h.reply('，？！\u2003');
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.state()).pets.main?.say?.data ?? null, null);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'content-empty');
  assert.equal(existsSync(join(h.userRoot, 'whisper-content.json')), false);
  await h.tick();
  assert.equal(h.calls.length, 1);
  h.advance(300000);
  h.reply('安静待一会儿。');
  await h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'published');
});

test('manual chat and manual whisper bypass content deduplication and do not populate or refresh its automatic cache', async (t) => {
  const h = harness(t);
  h.reply('人手请求也能得到同一句。');
  await h.chat('请回复');
  assert.equal((await h.call('/whisper?pet=main', 'POST')).body.ok, true);
  const manual = (await h.state()).pets.main.say;
  assert.equal(h.calls.length, 2);
  assert.equal(
    existsSync(join(h.userRoot, 'whisper-content.json')),
    false,
    'manual results never create automatic fingerprints',
  );
  h.advance(300000);
  await h.tick();
  assert.equal(h.calls.length, 3);
  const automatic = (await h.state()).pets.main.say;
  assert.ok(automatic.counter > manual.counter);
  const raw = readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8');
  assert.equal((await h.call('/whisper?pet=main', 'POST')).body.ok, true);
  const bypassed = (await h.state()).pets.main.say;
  assert.ok(bypassed.counter > automatic.counter);
  await h.chat('继续');
  const afterManual = (await h.state()).pets.main.say;
  assert.ok(afterManual.counter > bypassed.counter);
  assert.equal(h.calls.length, 5);
  assert.equal(
    readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8'),
    raw,
    'manual requests cannot extend automatic content TTL',
  );
  h.advance(300000);
  await h.tick();
  assert.equal(h.calls.length, 6);
  assert.deepEqual((await h.state()).pets.main.say, afterManual);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'content-repeat');
});

test('quiet mode discards in-flight content before fingerprinting so that the same line can publish after quiet mode ends', async (t) => {
  const h = harness(t);
  h.reply('这句还没有投递。');
  let release;
  h.hold(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  await h.tick();
  const current = (await h.call('/config')).body.main;
  await h.call('/config', 'PUT', { ...current, doNotDisturb: true });
  release();
  await new Promise(setImmediate);
  assert.equal((await h.state()).pets.main?.say?.data ?? null, null);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'quiet-mode');
  assert.equal(existsSync(join(h.userRoot, 'whisper-content.json')), false);
  await h.call('/config', 'PUT', { ...current, doNotDisturb: false });
  h.hold(undefined);
  h.advance(300000);
  await h.tick();
  assert.equal(h.calls.length, 2);
  assert.ok((await h.state()).pets.main.say.counter > 0);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'published');
  assert.equal(JSON.parse(readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8')).pets[0].entries.length, 1);
});

test('automatic content fingerprints survive restart and expire after thirty minutes without duplicate attempts extending TTL', async (t) => {
  const h = harness(t);
  h.reply('短期记得这一句。');
  await h.tick();
  h.advance(300000);
  h.restart();
  await h.tick();
  assert.equal(h.calls.length, 2);
  assert.equal((await h.state()).pets.main?.say?.data ?? null, null, 'restart does not replay a cached line');
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'content-repeat');
  h.advance(25 * 60 * 1000);
  await h.tick();
  assert.equal(h.calls.length, 3);
  assert.ok((await h.state()).pets.main.say.counter > 0);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'published');
  assert.equal(JSON.parse(readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8')).pets[0].entries.length, 1);
  scenarioEvidence(t, 'automatic-content-restart-expiry', {
    modelStubCalls: h.calls.length,
    repeatedAtMinutes: 5,
    publishedAtMinutes: 30,
  });
});

test('real working state blocks generation before the content cache and does not reserve unseen text', async (t) => {
  const h = harness(t);
  h.reply('第一句已发布。');
  await h.tick();
  const first = (await h.state()).pets.main.say;
  const raw = readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8');
  h.emit('fixture-work-before-content', { type: 'turn/start', seq: 1 });
  h.advance(300000);
  h.reply('第二句还没发布。');
  await h.tick();
  assert.equal(h.calls.length, 1);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'working');
  assert.equal(readFileSync(join(h.userRoot, 'whisper-content.json'), 'utf8'), raw);
  h.emit('fixture-work-before-content', { type: 'turn/end', seq: 2, data: { reason: { kind: 'aborted' } } });
  h.advance(300000);
  await h.tick();
  assert.equal(h.calls.length, 2);
  assert.ok((await h.state()).pets.main.say.counter > first.counter);
  assert.equal((await h.diagnostics()).diagnostics.records.at(-1).reason, 'published');
});
