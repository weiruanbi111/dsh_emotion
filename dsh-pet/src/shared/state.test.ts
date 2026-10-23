/**
 * 轮询统一状态 S 的客户端侧逻辑单元测试（拉取容错 / 拍平 / 比对 / 余额叶子解析）。
 *
 * 钉住的不变式：
 *   - 首拉只记基线、不产出变化（否则页面刷新会重放旧气泡）；
 *   - counter 没变 → 不产出（同一句话不会被反复渲染）；
 *   - 新增的 section / 宠物自动纳入（将来加叶子不用改这段逻辑）；
 *   - 脏数据（counter 非数字 / 叶子非对象）被丢弃，不把垃圾送进渲染层；
 *   - 余额叶子要解析成客户端视图（raw.data 摊平），并带上 host 标的手动标记。
 *
 * 跑法：node --experimental-strip-types --test src/shared/state.test.ts
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

import {
  chooseSayAnimation,
  continueWorkStatusAnimation,
  flattenCounters,
  readBalance,
  readSay,
  takeChanged,
  type PollState,
} from './state.ts';
import { isEventAnim, pick, pickSlot } from './pickers.ts';
import { WORK_STATUS_INDEX } from './work-status.ts';
import type { Animations } from './types.ts';

/** 造一份 S：sections / pets 用简写（叶子值 = counter，data 用 data 字段给） */
function makeState(
  sections: Record<string, [number, unknown]>,
  pets: Record<string, Record<string, [number, unknown]>> = {},
): PollState {
  const leaf = ([counter, data]: [number, unknown]) => ({ counter, data });
  return {
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, leaf(v)])),
    pets: Object.fromEntries(
      Object.entries(pets).map(([petId, leaves]) => [
        petId,
        Object.fromEntries(Object.entries(leaves).map(([k, v]) => [k, leaf(v)])),
      ]),
    ),
  };
}

describe('flattenCounters —— 首拉基线', () => {
  test('路径为 sections.<名> / pets.<id>.<名>', () => {
    const s = makeState({ balance: [11, {}] }, { main: { say: [22, {}] } });
    assert.deepEqual(flattenCounters(s), { 'sections.balance': 11, 'pets.main.say': 22 });
  });

  test('空 S → 空基线（不抛）', () => {
    assert.deepEqual(flattenCounters({ sections: {}, pets: {} }), {});
  });
});

describe('takeChanged —— counter 变了才算变化', () => {
  test('没变 → 不产出（同一句话不会反复渲染）', () => {
    const baseline = { 'sections.balance': 11 };
    const changes = takeChanged(makeState({ balance: [11, { ok: true }] }), baseline);
    assert.deepEqual(changes, []);
  });

  test('变了 → 产出该叶子，并就地推进基线（下一次同样内容不再产出）', () => {
    const baseline: Record<string, number> = {};
    const s = makeState({ balance: [12, { ok: true }] });
    const first = takeChanged(s, baseline);
    assert.equal(first.length, 1);
    assert.equal(first[0].path, 'sections.balance');
    assert.deepEqual(first[0].leaf.data, { ok: true });
    assert.equal(baseline['sections.balance'], 12, '基线必须被推进');
    assert.deepEqual(takeChanged(s, baseline), [], '同一份 S 再比一次不应再产出');
  });

  test('基线里没有的叶子（新增宠物/section）也算变化', () => {
    const baseline = { 'sections.balance': 11 };
    const changes = takeChanged(
      makeState({ balance: [11, {}] }, { 'pet-9': { say: [7, { text: '新来的' }] } }),
      baseline,
    );
    assert.deepEqual(
      changes.map((c) => c.path),
      ['pets.pet-9.say'],
    );
  });

  test('多个叶子同时变化 → 全部产出（顺序：sections 在前、pets 在后）', () => {
    const baseline = { 'sections.balance': 1, 'pets.main.say': 1 };
    const changes = takeChanged(makeState({ balance: [2, {}] }, { main: { say: [2, {}] } }), baseline);
    assert.deepEqual(
      changes.map((c) => c.path),
      ['sections.balance', 'pets.main.say'],
    );
  });

  test('宠物 id 含点号也能正确区分（路径只当不透明键，绝不解析）', () => {
    const baseline: Record<string, number> = {};
    const changes = takeChanged(makeState({}, { 'a.b': { say: [5, { text: 'x' }] } }), baseline);
    assert.deepEqual(
      changes.map((c) => c.path),
      ['pets.a.b.say'],
    );
  });
});

describe('readBalance —— 余额叶子 → 客户端视图', () => {
  test('money：raw.data 摊平到视图顶层（含数据自带的档位基准与峰谷装饰）', () => {
    const hit = readBalance({
      counter: 1,
      data: {
        ok: true,
        provider: 'deepseek',
        shape: 'money',
        data: { currency: 'CNY', total: '10.00', fullBalance: '20', tier: 'idle' },
      },
    });
    assert.deepEqual(hit, {
      state: {
        provider: 'deepseek',
        shape: 'money',
        ok: true,
        currency: 'CNY',
        total: '10.00',
        granted: undefined,
        toppedUp: undefined,
        fullBalance: '20',
        tier: 'idle',
      },
      manual: false,
    });
  });

  test('windows：三窗口用量是数字才认，非数字 → null（不把 NaN 送进展示层）', () => {
    const good = readBalance({
      counter: 1,
      data: { ok: true, provider: 'opencode', shape: 'windows', data: { rolling: 1, weekly: 2, monthly: 3 } },
    });
    assert.equal(good?.state.ok, true);
    const bad = readBalance({
      counter: 1,
      data: { ok: true, provider: 'opencode', shape: 'windows', data: { rolling: 'x', weekly: 2, monthly: 3 } },
    });
    assert.equal(bad, null);
  });

  test('不可用：reason 原样保留，非法 reason 归一成 fetch-error', () => {
    const hit = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'credential-missing' } });
    assert.deepEqual(hit?.state, { provider: 'p', ok: false, reason: 'credential-missing', message: undefined });
    const weird = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: '???' } });
    assert.equal(weird?.state.ok === false && weird.state.reason, 'fetch-error');
  });

  test('manual 标记：host 标的 true 才算手动触发（决定"不可用时要不要必弹"）', () => {
    const manual = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'unsupported', manual: true } });
    assert.equal(manual?.manual, true);
    const auto = readBalance({ counter: 1, data: { ok: false, provider: 'p', reason: 'unsupported' } });
    assert.equal(auto?.manual, false);
    const notBool = readBalance({
      counter: 1,
      data: { ok: false, provider: 'p', reason: 'unsupported', manual: 'yes' },
    });
    assert.equal(notBool?.manual, false, '只有严格 true 才算');
  });

  test('脏数据 → null（消费端跳过这一拍，不抛）', () => {
    assert.equal(readBalance({ counter: 1, data: null }), null);
    assert.equal(readBalance({ counter: 1, data: 'nope' }), null);
    assert.equal(readBalance({ counter: 1, data: { ok: true, provider: 'p', shape: '未知' } }), null);
    assert.equal(readBalance({ counter: 1, data: { ok: true, provider: 'p', shape: 'money' } }), null, '缺 data 段');
  });
});

const speechAnimations: Animations = {
  idle: ['待机'],
  turn: [],
  drag: [],
  clicks: ['点击'],
  moves: { default: {}, actions: [] },
  categories: [{ id: 'words', weight: 1, noMirror: true, actions: ['谢谢'] }],
  events: { whisper: [['说话']], workStatus: ['完成'] },
};

describe('说话情绪动画契约', () => {
  test('旧载荷不附字段，null 与配置名称保留，异常类型仅降级动画', () => {
    assert.deepEqual(readSay({ counter: 1, data: { text: '你好' } }), { text: '你好', image: undefined });
    for (const cue of [null, '完成', 1, {}, '']) {
      const result = readSay({ counter: 1, data: { text: '你好', emotionAnimation: cue } });
      assert.equal(result?.text, '你好');
      assert.equal(result?.emotionAnimation, cue === '完成' ? cue : null);
    }
    assert.equal(readSay({ counter: 1, data: { emotionAnimation: '完成' } }), null);
  });

  test('旧载荷随机选 whisper，情绪名字只能从该宠物完整配置中选', () => {
    assert.equal(chooseSayAnimation(speechAnimations, undefined), '说话');
    for (const name of ['完成', '待机', '点击', '谢谢']) {
      assert.equal(chooseSayAnimation(speechAnimations, name), name);
    }
    for (const name of [null, '未知素材', '../../other']) {
      assert.equal(chooseSayAnimation(speechAnimations, name), null);
    }
  });

  test('缺 whisper 或空候选档位时返回文字降级；显式情绪动画仍可用', () => {
    const noWhisper = { ...speechAnimations, events: { workStatus: ['完成'] } };
    assert.equal(chooseSayAnimation(noWhisper, undefined), null);
    assert.equal(chooseSayAnimation(noWhisper, '完成'), '完成');
    assert.equal(chooseSayAnimation({ ...noWhisper, events: { whisper: [[]] } }, undefined), null);
  });
});

describe('工作动画续播只能依据真实当前档位', () => {
  const pool = [['共同素材', '思考'], ['共同素材', '工作'], '整理', '等待', ['庆祝A', '庆祝B'], '失败'];

  test('不续播回复借用的终态动画或其它工作档位', () => {
    for (const name of ['庆祝A', '失败', '思考', '待机']) {
      assert.equal(continueWorkStatusAnimation(pool, 'working', name), null);
    }
  });

  test('同名素材属于多个档位时，只从真实档位选下一段', () => {
    assert.deepEqual(continueWorkStatusAnimation(pool, 'working', '共同素材'), { name: '工作', once: true });
    assert.deepEqual(continueWorkStatusAnimation(pool, 'thinking', '共同素材'), { name: '思考', once: true });
    assert.deepEqual(continueWorkStatusAnimation(pool, 'waiting', '等待'), { name: '等待', once: false });
  });

  test('终态和空闲不继续工作循环', () => {
    assert.equal(continueWorkStatusAnimation(pool, 'success', '庆祝A'), null);
    assert.equal(continueWorkStatusAnimation(pool, 'error', '失败'), null);
    assert.equal(continueWorkStatusAnimation(pool, null, '工作'), null);
    assert.equal(continueWorkStatusAnimation([], 'working', '工作'), null);
  });
});

describe('桌面实际脚本的说话消费', () => {
  function harness(animations: Animations = speechAnimations) {
    const calls = {
      rendered: 0,
      stopped: 0,
      played: [] as string[],
      switched: [] as { name: string; once: boolean }[],
      timers: [] as (() => void)[],
    };
    const context = createContext({
      S: {
        chooseSayAnimation,
        continueWorkStatusAnimation,
        readSay,
        isEventAnim,
        pick,
        pickSlot,
        WORK_STATUS_INDEX,
        whisperBubbleView: ({ text }: { text: string }) => [{ text }],
        isNoMirrorAnimation: (categories: Animations['categories'], name: string) =>
          categories.some((category) => category.noMirror && category.actions.includes(name)),
      },
      BUBBLE_DURATION_MS: 10000,
      window: {
        setTimeout: (fn: () => void) => calls.timers.push(fn),
        clearTimeout: () => {},
      },
      console: { log: () => {} },
      sprites: [],
    });
    runInContext(readFileSync(new URL('../../runtime/electron-helper/sprite.js', import.meta.url), 'utf8'), context);
    runInContext(readFileSync(new URL('../../runtime/electron-helper/events.js', import.meta.url), 'utf8'), context);
    const sprite = runInContext('Object.create(PetSprite.prototype)', context);
    Object.assign(sprite, {
      animations,
      anim: '待机',
      facing: 'right',
      dragState: { active: false },
      workState: null,
      pet: { id: 'main' },
      whisperTimer: null,
      renderBubble: () => calls.rendered++,
      stopMove: () => calls.stopped++,
      switchTo: (name: string, once: boolean) => {
        calls.switched.push({ name, once });
        if (once) calls.played.push(name);
      },
    });
    context.sprites.push(sprite);
    return { context, sprite, calls };
  }

  test('消费真实 say 叶子，传递情绪素材，并修正含文字素材的镜像', () => {
    const { context, sprite, calls } = harness();
    runInContext("applySayLeaf('main', {counter: 1, data: {text: '收到夸奖', emotionAnimation: '谢谢'}})", context);
    assert.deepEqual(calls.played, ['谢谢']);
    assert.equal(sprite.facing, 'left');
    assert.equal(sprite.whisperView[0].text, '收到夸奖');
    assert.equal(calls.stopped, 1);
    assert.equal(calls.timers.length, 1);
    calls.timers[0]();
    assert.equal(sprite.whisperOn, false);
  });

  test('缺池、null、不存在名称都展示文字且不打断当前动画', () => {
    const noWhisper = { ...speechAnimations, events: {} };
    for (const cue of [undefined, null, '未知素材']) {
      const { sprite, calls } = harness(noWhisper);
      sprite.showWhisper('依然显示', undefined, cue);
      assert.equal(sprite.whisperOn, true);
      assert.equal(sprite.whisperView[0].text, '依然显示');
      assert.deepEqual(calls.played, []);
      assert.equal(calls.stopped, 0);
      assert.equal(calls.timers.length, 1);
    }
  });

  test('旧载荷保留随机说话动画', () => {
    const { sprite, calls } = harness();
    sprite.showWhisper('旧消息');
    assert.deepEqual(calls.played, ['说话']);
  });

  const workAnimations: Animations = {
    ...speechAnimations,
    events: { whisper: ['说话'], workStatus: [['思考A', '思考B'], '工作', '整理', '等待', ['庆祝A', '庆祝B'], '失败'] },
  };

  test('工作中聊天庆祝动画只播一次，ended 恢复真实工作档位', () => {
    const { sprite, calls } = harness(workAnimations);
    sprite.workState = 'working';
    sprite.showWhisper('谢谢夸奖', undefined, '庆祝A');
    sprite.handleEnded();
    assert.deepEqual(calls.switched, [
      { name: '庆祝A', once: true },
      { name: '工作', once: false },
    ]);
    assert.equal(sprite.anim, '工作');
    assert.equal(sprite.once, false);
  });

  test('工作中平静回复借用 idle，ended 仍恢复真实工作档位', () => {
    const { sprite, calls } = harness(workAnimations);
    sprite.workState = 'working';
    sprite.showWhisper('慢慢来', undefined, '待机');
    sprite.handleEnded();
    assert.deepEqual(calls.switched, [
      { name: '待机', once: true },
      { name: '工作', once: false },
    ]);
    assert.equal(sprite.anim, '工作');
    assert.equal(sprite.once, false);
  });

  test('真实工作多候选继续正常档内轮换', () => {
    const rotating = {
      ...workAnimations,
      events: { ...workAnimations.events, workStatus: ['思考', ['工作A', '工作B']] },
    };
    const { sprite, calls } = harness(rotating);
    sprite.workState = 'working';
    sprite.anim = '工作A';
    sprite.handleEnded();
    assert.deepEqual(calls.switched, [{ name: '工作B', once: true }]);
  });

  test('其它工作档位被借用时不能错误轮换，必须恢复当前工作', () => {
    const { sprite, calls } = harness(workAnimations);
    sprite.workState = 'working';
    sprite.anim = '思考A';
    sprite.handleEnded();
    assert.deepEqual(calls.switched, [{ name: '工作', once: false }]);
  });

  test('工作结束或空闲时庆祝只播一次，然后回 idle', () => {
    for (const state of ['success', null]) {
      const { sprite, calls } = harness(workAnimations);
      sprite.workState = state;
      sprite.showWhisper('完成啦', undefined, '庆祝A');
      sprite.handleEnded();
      assert.deepEqual(calls.switched, [
        { name: '庆祝A', once: true },
        { name: '待机', once: true },
      ]);
    }
  });
});
