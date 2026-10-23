import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';

import { EmotionStore, emotionAnimation, type EmotionSnapshot } from './emotion.ts';

function fixture(t: TestContext): { path: string; directory: string } {
  // Keep atomic rename tests on the project filesystem (some Windows temp sandboxes deny rename).
  const prefix = resolve(import.meta.dirname, '../../.emotion-test-');
  const directory = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)), 'only remove this test fixture');
    rmSync(directory, { recursive: true, force: true });
  });
  return { path: join(directory, 'emotion.json'), directory };
}

test('events are bounded, independent per pet, and do-not-disturb does not lower valence', (t) => {
  const { path } = fixture(t);
  const store = new EmotionStore(path, () => 1000);
  assert.deepEqual(store.snapshot('main'), { valence: 0, arousal: 0.35, updatedAt: 1000, label: 'calm' });
  for (let i = 0; i < 20; i++) store.apply('happy', 'praise', `praise-${i}`);
  assert.equal(store.snapshot('happy').valence, 1);
  assert.equal(store.snapshot('happy').arousal, 1);
  for (let i = 0; i < 30; i++) store.apply('low', 'task-failed', `failure-${i}`);
  assert.equal(store.snapshot('low').valence, -1);
  assert.equal(store.snapshot('low').label, 'subdued');
  for (let i = 0; i < 20; i++) store.apply('happy', 'do-not-disturb', `dnd-${i}`);
  assert.equal(store.snapshot('happy').valence, 1);
  assert.equal(store.snapshot('happy').arousal, 0);
  assert.equal(store.snapshot('main').valence, 0);
});

test('emotion returns toward its baseline with a 30 minute half-life before new events', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  store.apply('main', 'task-completed', 'complete');
  const initial = store.snapshot('main');
  now += 30 * 60 * 1000;
  const half = store.snapshot('main');
  assert.ok(Math.abs(half.valence - initial.valence / 2) < 1e-12);
  assert.ok(Math.abs(half.arousal - (0.35 + (initial.arousal - 0.35) / 2)) < 1e-12);
  store.apply('main', 'praise', 'later-praise');
  assert.ok(Math.abs(store.snapshot('main').valence - (half.valence + 0.28)) < 1e-12);
  now += 100 * 30 * 60 * 1000;
  assert.ok(Math.abs(store.snapshot('main').valence) < 1e-12);
  assert.ok(Math.abs(store.snapshot('main').arousal - 0.35) < 1e-12);
  assert.equal(store.snapshot('main').label, 'calm');
});

test('clock rollback cannot amplify emotion or bypass proactive cooldown', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  store.apply('main', 'praise', 'praise');
  assert.equal(store.reserveProactive('main', 'first', 100), true);
  const before = store.snapshot('main');
  now = 0;
  assert.deepEqual(store.snapshot('main'), before);
  assert.equal(store.reserveProactive('main', 'rolled-back', 100), false);
  store.apply('main', 'do-not-disturb', 'dnd');
  assert.equal(store.snapshot('main').updatedAt, 1000);
  now = 1100;
  assert.equal(store.reserveProactive('main', 'after-cooldown', 100), true);
});

test('event deduplication survives restart and its retained IDs are bounded', (t) => {
  const { path } = fixture(t);
  const store = new EmotionStore(path, () => 1000);
  assert.equal(store.apply('main', 'praise', 'same-event'), true);
  assert.equal(store.apply('main', 'praise', 'same-event'), false);
  const reloaded = new EmotionStore(path, () => 1000);
  assert.equal(reloaded.apply('main', 'praise', 'same-event'), false);
  assert.deepEqual(reloaded.snapshot('main'), store.snapshot('main'));
  for (let i = 0; i < 150; i++) reloaded.apply('main', 'praise', `event-${i}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(data.version, 1);
  assert.equal(data.pets.main.eventIds.length, 128);
  assert.equal(reloaded.apply('main', 'praise', 'event-149'), false);
  assert.equal(reloaded.apply('main', 'praise', 'event-0'), true);
  assert.equal(reloaded.apply('main', 'praise', ''), false);
});

test('proactive reservation is first-use friendly and consumes cooldown before generation', (t) => {
  const { path } = fixture(t);
  let now = 0;
  const store = new EmotionStore(path, () => now);
  assert.equal(store.reserveProactive('main', 'first'), true);
  assert.equal(store.reserveProactive('main', 'different-event'), false);
  assert.equal(store.reserveProactive('other', 'first'), true);
  now = 300000;
  assert.equal(store.reserveProactive('main', 'first'), false, 'dedup still applies after cooldown');
  assert.equal(store.reserveProactive('main', 'second'), true);
  const reloaded = new EmotionStore(path, () => now);
  assert.equal(reloaded.reserveProactive('main', 'third'), false, 'restart preserves reservation');
  now += 300000;
  assert.equal(reloaded.reserveProactive('main', 'second'), false);
  assert.equal(reloaded.reserveProactive('main', 'third'), true);
});

test('reset clears emotion and event history while preserving cooldown for one or all pets', (t) => {
  const { path } = fixture(t);
  const store = new EmotionStore(path, () => 1000);
  store.apply('main', 'praise', 'praise');
  store.apply('other', 'task-failed', 'failure');
  store.reserveProactive('main', 'reserved');
  store.reset('main');
  assert.equal(store.snapshot('main').valence, 0);
  assert.equal(store.snapshot('main').arousal, 0.35);
  assert.equal(store.snapshot('other').label, 'subdued');
  assert.equal(store.reserveProactive('main', 'after-reset'), false);
  assert.equal(store.apply('main', 'praise', 'praise'), true);
  store.reset();
  assert.equal(store.snapshot('other').valence, 0);
  assert.equal(store.snapshot('main').valence, 0);
  const reloaded = new EmotionStore(path, () => 1000);
  assert.equal(reloaded.reserveProactive('main', 'after-restart'), false);
});

test('manual interaction postpones automatic speech across restart and reset', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  store.noteInteraction('main');
  assert.equal(store.reserveProactive('main', 'after-chat'), false);
  now += 300000;
  assert.equal(store.reserveProactive('main', 'after-rest'), true);
  now += 300000;
  store.noteInteraction('main');
  const reloaded = new EmotionStore(path, () => now);
  reloaded.reset('main');
  assert.equal(reloaded.reserveProactive('main', 'after-reload-reset'), false);
  now += 300000;
  assert.equal(reloaded.reserveProactive('main', 'after-cooldown'), true);
});

test('damaged state is preserved exactly and the next event starts a new versioned file', (t) => {
  const { path, directory } = fixture(t);
  const damaged = '{ damaged private content';
  writeFileSync(path, damaged, 'utf8');
  const warning = t.mock.method(console, 'warn', () => {});
  const store = new EmotionStore(path, () => 1000);
  assert.equal(store.snapshot('main').valence, 0);
  const backup = readdirSync(directory).find((name) => name.startsWith('emotion.json.corrupt-'));
  assert.ok(backup);
  assert.equal(readFileSync(join(directory, backup), 'utf8'), damaged);
  assert.equal(store.apply('main', 'praise', 'recover'), true);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).version, 1);
  assert.ok(warning.mock.calls.length > 0);
  assert.ok(warning.mock.calls.every((call) => !JSON.stringify(call.arguments).includes(damaged)));
  assert.equal(readdirSync(directory).filter((name) => name.includes('.tmp-')).length, 0);
});

test('malformed version is preserved and loaded numeric states stay within bounds', (t) => {
  const { path, directory } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  writeFileSync(path, JSON.stringify({ version: 99, pets: {} }), 'utf8');
  const store = new EmotionStore(path, () => 1000);
  assert.equal(store.snapshot('main').label, 'calm');
  assert.equal(readdirSync(directory).filter((name) => name.startsWith('emotion.json.corrupt-')).length, 1);
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      pets: {
        main: { valence: 100, arousal: -100, updatedAt: 1000, eventIds: [], proactiveIds: [], lastProactiveAt: null },
      },
    }),
    'utf8',
  );
  const bounded = new EmotionStore(path, () => 1000).snapshot('main');
  assert.equal(bounded.valence, 1);
  assert.equal(bounded.arousal, 0);
});

test('persistence failures keep the state usable without logging stored contents', (t) => {
  const { path, directory } = fixture(t);
  const warning = t.mock.method(console, 'warn', () => {});
  const store = new EmotionStore(path, () => 1000);
  mkdirSync(path); // A directory at the final file path makes atomic rename fail.
  assert.doesNotThrow(() => store.apply('main', 'praise', 'private-event-id'));
  assert.equal(store.snapshot('main').label, 'cheerful');
  assert.equal(store.reserveProactive('main', 'private-reservation'), true);
  assert.equal(store.reserveProactive('main', 'next-reservation'), false);
  assert.ok(warning.mock.calls.length >= 1);
  assert.ok(warning.mock.calls.every((call) => !JSON.stringify(call.arguments).includes('private-')));
  assert.equal(readdirSync(directory).filter((name) => name.includes('.tmp-')).length, 0);
});

test('context identifies simulated pet state and forbids guesses or guilt about user absence', (t) => {
  const { path } = fixture(t);
  const store = new EmotionStore(path, () => 1000);
  store.apply('main', 'task-failed', 'failure');
  const context = store.context('main');
  assert.match(context, /桌宠自身的模拟状态/);
  assert.match(context, /不是用户的情绪或状态/);
  assert.match(context, /不虚构用户/);
  assert.match(context, /不因用户离开或未回复/);
  assert.match(context, /不用内疚/);
  assert.match(context, /不要求回复/);
  assert.match(context, /明确上报执行错误/);
  assert.match(context, /不能证明任务产出的真实质量/);
});

test('animation mapping uses configured slots and gracefully skips missing assets', () => {
  const snapshot: EmotionSnapshot = { valence: 0, arousal: 0.35, updatedAt: 0, label: 'calm' };
  const conf = {
    animations: {
      idle: ['idle-existing'],
      events: {
        workStatus: ['thinking', 'working', 'result', 'waiting', ['celebrate-existing'], 'subdued-existing'],
      },
    },
  };
  assert.equal(emotionAnimation(snapshot, conf), 'idle-existing');
  assert.equal(emotionAnimation({ ...snapshot, label: 'cheerful' }, conf), 'celebrate-existing');
  assert.equal(emotionAnimation({ ...snapshot, label: 'subdued' }, conf), 'subdued-existing');
  assert.equal(emotionAnimation({ ...snapshot, label: 'cheerful' }, { animations: { idle: ['idle'] } }), null);
  for (const missing of [{}, { animations: {} }, { animations: { idle: [] } }, { animations: { idle: [''] } }]) {
    assert.equal(emotionAnimation(snapshot, missing), null);
  }
});

test('host turn completion is weak evidence with a per-session ten-minute ceiling', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  const states = [];
  for (let seq = 1; seq <= 8; seq++) {
    assert.equal(
      store.applyHostCompletion('main', `work:${seq}`, 'session-a'),
      seq <= 3 ? 'accepted' : 'session-completion-limit',
    );
    states.push(store.snapshot('main'));
    now += 1000;
  }
  assert.ok(states.every((state) => state.valence <= 0.24 && state.arousal <= 0.47));
  assert.ok(states[3].valence < states[2].valence, 'ignored events add no positive change while time still decays');
  assert.equal(store.applyHostCompletion('main', 'work:8', 'session-a'), 'duplicate-event');
  assert.equal(store.applyHostCompletion('other', 'work:9', 'session-a'), 'accepted');
  assert.equal(store.applyHostCompletion('main', 'work:10', 'session-b'), 'accepted');
  assert.equal(store.applyHostCompletion('main', 'invalid', 'unknown'), 'invalid-event');
  assert.match(store.context('main'), /不是用户确认的成果/);
});

test('completion ceiling survives restart, expires, and remembers ignored transport IDs', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  for (let seq = 1; seq <= 3; seq++) store.applyHostCompletion('main', `work:${seq}`, 'session');
  const reloaded = new EmotionStore(path, () => now);
  assert.equal(reloaded.applyHostCompletion('main', 'limited', 'session'), 'session-completion-limit');
  const before = reloaded.snapshot('main');
  now = 0;
  assert.equal(reloaded.applyHostCompletion('main', 'clock-rollback', 'session'), 'session-completion-limit');
  assert.deepEqual(reloaded.snapshot('main'), before);
  now = 601000;
  assert.equal(reloaded.applyHostCompletion('main', 'limited', 'session'), 'duplicate-event');
  assert.equal(reloaded.applyHostCompletion('main', 'later', 'session'), 'accepted');
  reloaded.reset('main');
  assert.equal(reloaded.applyHostCompletion('main', 'after-reset', 'session'), 'accepted');
});

test('completion control metadata uses bounded hashes and tolerates older version-one records', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  const store = new EmotionStore(path, () => now);
  for (let seq = 0; seq < 40; seq++) store.applyHostCompletion('main', `event-${seq}`, `private-session-${seq}`);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(data.pets.main.completionWindows.length, 32);
  assert.ok(
    data.pets.main.completionWindows.every((entry: { source: string }) => /^[a-f0-9]{64}$/u.test(entry.source)),
  );
  assert.doesNotMatch(JSON.stringify(data.pets.main.completionWindows), /private-session/);
  now += 600000;
  const expired = new EmotionStore(path, () => now);
  expired.noteInteraction('main');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).pets.main.completionWindows, []);
  delete data.pets.main.completionWindows;
  writeFileSync(path, JSON.stringify(data), 'utf8');
  const old = new EmotionStore(path, () => 1000);
  assert.equal(old.applyHostCompletion('main', 'new-event', 'session'), 'accepted');
});
