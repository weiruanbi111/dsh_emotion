import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WhisperContentStore } from './whisper-content.ts';

const WINDOW_MS = 30 * 60 * 1000;

function fixture(t: TestContext): { path: string; directory: string } {
  const prefix = resolve(import.meta.dirname, '../../.whisper-content-test-');
  const directory = mkdtempSync(prefix);
  t.after(() => {
    assert.ok(resolve(directory).startsWith(prefix), 'only remove this test fixture');
    rmSync(directory, { recursive: true, force: true });
  });
  return { path: join(directory, 'whisper-content.json'), directory };
}

test('checks do not remember candidates; published text matches normalized punctuation, whitespace and case variants', (t) => {
  const { path } = fixture(t);
  const store = new WhisperContentStore(path, () => 1000);
  assert.deepEqual(store.check('main', '你好，Ｔｅａ！'), { accepted: true, reason: 'content-new' });
  assert.equal(store.check('main', '你好 Tea').accepted, true, 'checking is not publishing');
  assert.equal(store.remember('main', '你好，Ｔｅａ！'), true);
  assert.deepEqual(store.check('main', '你 好\u2003tea。。。\uFEFF'), { accepted: false, reason: 'content-repeat' });
  assert.equal(store.remember('main', '你好 TEA'), false);
  assert.deepEqual(store.check('main', '，？！\u2003\uFEFF'), { accepted: false, reason: 'content-empty' });
  assert.equal(store.remember('main', '   '), false);
  assert.equal(store.check('main', '我去泡杯茶').accepted, true, 'no semantic deduplication claim');
  assert.equal(store.check('main', '你好 tea☕').accepted, true, 'symbols remain meaningful');
});

test('only short-lived hashes and timestamps are saved, with independent pet windows', (t) => {
  const { path } = fixture(t);
  const store = new WhisperContentStore(path, () => 1000);
  const privateLine = '这句原文不能保存在内容避重文件里';
  store.remember('main', privateLine);
  assert.equal(store.check('other', privateLine).accepted, true);
  assert.equal(store.remember('other', privateLine), true);
  assert.equal(store.check('main', privateLine).reason, 'content-repeat');
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(privateLine), false);
  const persisted = JSON.parse(raw);
  assert.deepEqual(Object.keys(persisted), ['version', 'pets']);
  assert.equal(persisted.version, 1);
  assert.equal(persisted.pets.length, 2);
  for (const pet of persisted.pets) {
    assert.deepEqual(Object.keys(pet), ['id', 'entries']);
    assert.deepEqual(Object.keys(pet.entries[0]), ['hash', 'at']);
    assert.match(pet.entries[0].hash, /^[a-f0-9]{64}$/);
  }
});

test('restart retains only the 30-minute window, and expiry happens exactly at its boundary', (t) => {
  const { path } = fixture(t);
  let now = 1000;
  new WhisperContentStore(path, () => now).remember('main', '安静陪伴');
  now += WINDOW_MS - 1;
  const reloaded = new WhisperContentStore(path, () => now);
  assert.equal(reloaded.check('main', '安静陪伴。').reason, 'content-repeat');
  now += 1;
  assert.equal(reloaded.check('main', '安静陪伴').accepted, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).pets, [], 'expired hashes are pruned from disk');
  assert.equal(reloaded.remember('main', '安静陪伴'), true);
  now += WINDOW_MS;
  const expiredReload = new WhisperContentStore(path, () => now);
  assert.equal(expiredReload.check('main', '安静陪伴').accepted, true);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).pets, []);
});

test('duplicate attempts do not extend the window, and clock rollback cannot bypass it', (t) => {
  const { path } = fixture(t);
  let now = 10_000;
  const store = new WhisperContentStore(path, () => now);
  store.remember('main', '原句');
  now += WINDOW_MS - 1;
  assert.equal(store.remember('main', '原句！'), false);
  now = 0;
  assert.equal(store.check('main', '原句').reason, 'content-repeat');
  const reloaded = new WhisperContentStore(path, () => now);
  assert.equal(reloaded.check('main', '原句').reason, 'content-repeat');
  now = 10_000 + WINDOW_MS;
  assert.equal(store.check('main', '原句').accepted, true);
  assert.equal(reloaded.check('main', '原句').accepted, true);
});

test('storage is bounded to 16 entries per pet and 128 recently published pets', (t) => {
  const { path } = fixture(t);
  const store = new WhisperContentStore(path, () => 1000);
  for (let i = 0; i < 20; i++) store.remember('main', '句子' + i);
  assert.equal(store.check('main', '句子0').accepted, true);
  assert.equal(store.check('main', '句子19').reason, 'content-repeat');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).pets[0].entries.length, 16);
  for (let i = 0; i < 127; i++) store.remember('pet-' + i, '同一句');
  store.remember('main', '最近新句');
  store.remember('last', '最后一句');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.pets.length, 128);
  assert.equal(store.check('pet-0', '同一句').accepted, true, 'oldest published pet is evicted');
  assert.equal(store.check('main', '最近新句').reason, 'content-repeat');
  const reloaded = new WhisperContentStore(path, () => 1000);
  assert.equal(reloaded.check('main', '最近新句').reason, 'content-repeat');
  assert.equal(reloaded.check('last', '最后一句').reason, 'content-repeat');
});

test('damaged or unsupported content windows are preserved without logging their contents', (t) => {
  const { path, directory } = fixture(t);
  const damaged = '{ private damaged whisper metadata';
  writeFileSync(path, damaged, 'utf8');
  const warning = t.mock.method(console, 'warn', () => {});
  const store = new WhisperContentStore(path, () => 1000);
  const backup = readdirSync(directory).find((name) => name.startsWith('whisper-content.json.corrupt-'));
  assert.ok(backup);
  assert.equal(readFileSync(join(directory, backup), 'utf8'), damaged);
  assert.equal(store.remember('main', '新句'), true);
  assert.equal(new WhisperContentStore(path, () => 1000).check('main', '新句').reason, 'content-repeat');
  assert.ok(warning.mock.calls.every((call) => !JSON.stringify(call.arguments).includes('private')));
  writeFileSync(path, JSON.stringify({ version: 2, pets: [] }), 'utf8');
  assert.equal(new WhisperContentStore(path, () => 1000).check('main', '新句').accepted, true);
  assert.equal(readdirSync(directory).filter((name) => name.includes('.corrupt-')).length, 2);
});

test('malformed fingerprint entries are rejected and oversized valid windows are bounded on load', (t) => {
  const { path } = fixture(t);
  t.mock.method(console, 'warn', () => {});
  writeFileSync(path, JSON.stringify({ version: 1, pets: [{ id: 'main', entries: [{ hash: 'raw-text', at: 0 }] }] }));
  assert.equal(new WhisperContentStore(path, () => 1000).check('main', '新句').accepted, true);
  const entries = Array.from({ length: 20 }, (_, i) => ({ hash: i.toString(16).padStart(64, '0'), at: 1000 }));
  writeFileSync(
    path,
    JSON.stringify({ version: 1, pets: Array.from({ length: 150 }, (_, i) => ({ id: 'pet-' + i, entries })) }),
  );
  const bounded = new WhisperContentStore(path, () => 1000);
  const onLoad = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(onLoad.pets.length, 128);
  assert.ok(onLoad.pets.every((pet: { entries: unknown[] }) => pet.entries.length <= 16));
  bounded.remember('new', '新句');
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(saved.pets.length, 128);
  assert.ok(saved.pets.every((pet: { entries: unknown[] }) => pet.entries.length <= 16));
});

test('read and save failures retain in-memory deduplication and never print content', (t) => {
  const { path, directory } = fixture(t);
  const warning = t.mock.method(console, 'warn', () => {});
  const store = new WhisperContentStore(path, () => 1000);
  mkdirSync(path); // Atomic rename cannot replace a directory.
  assert.equal(store.remember('main', 'private-whisper-line'), true);
  assert.equal(store.check('main', 'private-whisper-line').reason, 'content-repeat');
  assert.ok(warning.mock.calls.length > 0);
  assert.ok(warning.mock.calls.every((call) => !JSON.stringify(call.arguments).includes('private-whisper-line')));
  assert.equal(readdirSync(directory).filter((name) => name.includes('.tmp-')).length, 0);
  const unreadable = new WhisperContentStore(path, () => 1000);
  assert.equal(unreadable.remember('main', '内存中仍可用'), true);
  assert.equal(unreadable.check('main', '内存中仍可用').reason, 'content-repeat');
});
