import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expressionPlan, type ExpressionInput } from './emotion-expression.ts';

const BASE: ExpressionInput = {
  snapshot: { valence: 0.56, arousal: 0.59, label: 'cheerful', updatedAt: 1000 },
  mode: 'chat',
  enabled: true,
  userText: '你好',
  conf: {
    whisperPrompt: 'PERSONA-KEEP-UNCHANGED',
    animations: { idle: ['平静待机'], events: { workStatus: [null, null, null, null, '轻快庆祝', '低落'] } },
  },
};

test('normal greeting preserves a warm persona while separating mood from situational facts', () => {
  const plan = expressionPlan(BASE);
  assert.equal(plan.strategy, 'warm-chat');
  assert.equal(plan.animation, '轻快庆祝');
  assert.match(plan.context, /固定人设描述身份与习惯/);
  assert.match(plan.context, /当前心情只影响用词和节奏/);
  assert.match(plan.context, /按这次普通问候自然回应/);
  assert.equal(BASE.conf.whisperPrompt, 'PERSONA-KEEP-UNCHANGED');
  assert.doesNotMatch(plan.context, /PERSONA-KEEP-UNCHANGED/);
});

test('explicit technical requests prioritize complete answers and a neutral existing animation after praise', () => {
  for (const userText of [
    '请解释 TypeScript 泛型怎么写？',
    '你好，帮我写一个排序算法',
    'How do I debug this API?',
    '请解释 async/await 与 Promise 的错误处理，分别给出完整示例。',
    '```ts\nconst answer = 42;\n```',
  ]) {
    const plan = expressionPlan({ ...BASE, userText, lastEvent: 'praise' });
    assert.equal(plan.strategy, 'technical', userText);
    assert.equal(plan.animation, '平静待机');
    assert.match(plan.context, /准确、完整地回应当前问题优先/);
    assert.match(plan.context, /20字以内.*仅适用于日常碎碎念/);
    assert.match(plan.context, /分步骤.*提供代码/);
    assert.match(plan.context, /不能删减必要解释、步骤、结论或代码/);
  }
});

test('a current observed error takes precedence over a positive mood without inventing its cause', () => {
  const plan = expressionPlan({ ...BASE, userText: '继续检查构建问题', workState: 'error' });
  assert.equal(plan.strategy, 'supportive-chat');
  assert.equal(plan.animation, '平静待机');
  assert.match(plan.context, /当前宿主上报了执行错误/);
  assert.match(plan.context, /不能据此断言失败原因、用户受挫或任务最终失败/);
  assert.match(plan.context, /不能删减必要解释、步骤、结论或代码/);
});

test('a user request for error help is supportive even when the host no longer reports an error', () => {
  for (const userText of [
    '我的脚本运行失败了，请帮我排查',
    '帮我修复这个 TypeError',
    '刚刚失败了，请再试一次',
    'My API request failed, help me debug it',
  ]) {
    const plan = expressionPlan({ ...BASE, userText, workState: null });
    assert.equal(plan.strategy, 'supportive-chat', userText);
    assert.equal(plan.animation, '平静待机');
    assert.match(plan.context, /用户当前明确提及技术错误/);
    assert.doesNotMatch(plan.context, /当前宿主上报了执行错误/);
  }
});

test('historical failures and stale terminal errors do not impose an error story on a fresh greeting', () => {
  const withoutHistory = expressionPlan(BASE);
  assert.deepEqual(expressionPlan({ ...BASE, lastEvent: 'task-failed' }), withoutHistory);
  const greeting = expressionPlan({ ...BASE, lastEvent: 'task-failed', workState: 'error' });
  assert.equal(greeting.strategy, 'warm-chat');
  assert.doesNotMatch(greeting.context, /当前宿主上报了执行错误|用户当前明确提及技术错误/);
  const technical = expressionPlan({
    ...BASE,
    userText: '请解释 CSS 的盒模型',
    lastEvent: 'task-failed',
    workState: null,
  });
  assert.equal(technical.strategy, 'technical');
});

test('quoted technical problems and definitions do not fabricate a current failure', () => {
  const story = expressionPlan({ ...BASE, userText: '有人说“我的代码运行失败了”，怎么安慰他？' });
  assert.equal(story.strategy, 'warm-chat');
  assert.doesNotMatch(story.context, /用户当前明确提及技术错误/);
  const definition = expressionPlan({ ...BASE, userText: 'TypeError 是什么意思？' });
  assert.equal(definition.strategy, 'technical');
  assert.doesNotMatch(definition.context, /用户当前明确提及技术错误/);
  for (const userText of [
    '如果运行脚本失败了应该怎么处理？',
    '“报错了”是什么意思？',
    'If my API request failed, how would I debug it?',
    '请解释编译失败的常见原因',
  ]) {
    const hypothetical = expressionPlan({ ...BASE, userText });
    assert.notEqual(hypothetical.strategy, 'supportive-chat', userText);
    assert.doesNotMatch(hypothetical.context, /用户当前明确提及技术错误/);
  }
});

test('missing code and error details remain explicit fact boundaries in every conversation mode', () => {
  for (const input of [
    BASE,
    { ...BASE, userText: '请帮我排查代码' },
    { ...BASE, mode: 'whisper' as const },
    { ...BASE, enabled: false },
  ]) {
    const plan = expressionPlan(input);
    assert.match(plan.context, /没有收到代码或具体报错内容时/);
    assert.match(plan.context, /不得声称已经看过、理解或修复它们/);
    assert.match(plan.context, /宿主回合完成只表示一次执行结束/);
    assert.match(plan.context, /不等于产出正确、任务成功或用户认可/);
  }
});

test('whispers allow quiet companionship without demanding a reaction or mirroring celebration', () => {
  const plan = expressionPlan({ ...BASE, mode: 'whisper', userText: undefined });
  assert.equal(plan.strategy, 'quiet-companion');
  assert.equal(plan.animation, '平静待机');
  assert.match(plan.context, /安静陪伴是合法选择/);
  assert.match(plan.context, /不要求每次情绪变化都主动说话/);
  assert.match(plan.context, /不索取回复/);
  assert.match(plan.context, /不根据用户离开、未回复或沉默推断心情/);
});

test('feature off preserves animation behavior while retaining chat completeness and factual limits', () => {
  const plan = expressionPlan({ ...BASE, enabled: false, userText: '请解释 Python 的装饰器', workState: 'error' });
  assert.equal(plan.strategy, 'disabled');
  assert.equal(plan.animation, null);
  assert.match(plan.context, /连续情绪已关闭，保留原有语气与动画行为/);
  assert.match(plan.context, /准确、完整地回应当前问题优先/);
  assert.match(plan.context, /不得声称已经看过、理解或修复它们/);
});

test('missing animation slots degrade to text and planning cannot mutate inputs or copy private text', () => {
  const input = { ...BASE, userText: '请检查这段代码 PRIVATE-USER-TEXT', conf: { whisperPrompt: 'PRIVATE-PERSONA' } };
  const original = JSON.stringify(input);
  const plan = expressionPlan(input);
  assert.equal(plan.strategy, 'technical');
  assert.equal(plan.animation, null);
  assert.equal(JSON.stringify(input), original);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE-/);
  const idlePool = expressionPlan({ ...input, conf: { animations: { idle: [['已有待机']] } } });
  assert.equal(idlePool.animation, '已有待机');
});
