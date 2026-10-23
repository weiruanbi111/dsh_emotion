import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isExplicitPraise, observedWorkEmotion, praiseEventId, proactivePeriodSec } from './emotion-policy.ts';

test('only explicit direct praise is observed, never a story or inferred user mood', () => {
  for (const text of ['你真棒！', '你做得真棒', '做得好', '你太可爱了'])
    assert.equal(isExplicitPraise(text), true, text);
  for (const text of [
    '你好',
    '你好啊',
    '他夸你真棒',
    '“你真棒”是什么意思',
    '我心情很好',
    '任务完成了',
    '你并不可爱',
    '你真棒？',
  ]) {
    assert.equal(isExplicitPraise(text), false, text);
  }
  assert.equal(praiseEventId('你真棒', 100), praiseEventId('你真棒', 200));
  assert.ok(!praiseEventId('你真棒', 100).includes('你真棒'));
});

test('only sequenced, observed terminal host events affect emotion', () => {
  const end = (kind: string, seq: unknown = 8) => ({ type: 'turn/end', seq, data: { reason: { kind } } });
  assert.equal(observedWorkEmotion(end('completed'), 'success'), 'task-completed');
  assert.equal(observedWorkEmotion(end('error'), 'error'), 'task-failed');
  assert.equal(observedWorkEmotion(end('timeout'), 'error'), 'task-failed');
  for (const event of [
    end('blocked'),
    end('aborted'),
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
    end('completed', 0),
    end('completed', '8'),
  ]) {
    assert.equal(observedWorkEmotion(event, 'success'), null);
  }
  assert.equal(observedWorkEmotion(end('completed'), 'result'), null, 'a goal continuation is not completion');
  assert.equal(observedWorkEmotion(end('completed'), 'error'), null, 'model goal blocked is not an execution failure');
  assert.equal(observedWorkEmotion({ type: 'assistant/message', seq: 9 }, 'success'), null);
});

test('subdued pets speak less often, without increasing requests above the cooldown', () => {
  assert.equal(proactivePeriodSec(300, 'subdued'), 450);
  assert.equal(proactivePeriodSec(20, 'cheerful'), 300);
  assert.equal(proactivePeriodSec(NaN, 'calm'), 300);
});
