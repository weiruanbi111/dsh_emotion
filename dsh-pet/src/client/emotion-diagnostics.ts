/** Local, on-demand diagnostics. Never render unknown response fields or generate content. */
import type { Dispatch, EffectCallback, DependencyList, SetStateAction } from 'react';
import type { jsx } from 'react/jsx-runtime';

export const emotionDiagnosticsZh = {
  'diagnostics.title': '本地情绪诊断',
  'diagnostics.show': '展开本地情绪诊断',
  'diagnostics.hide': '收起本地情绪诊断',
  'diagnostics.refresh': '刷新诊断',
  'diagnostics.loading': '正在读取本地诊断…',
  'diagnostics.error': '诊断读取失败，可点击刷新重试。',
  'diagnostics.forbidden': '仅允许本机同源界面读取诊断。请从本机 DeepSeek Harness 设置页打开。',
  'diagnostics.note':
    '每只宠物最多保留 80 条本进程记录，重启清空；不保存聊天原文、完整提示词或密钥。此处是程序诊断，不代表模型回复质量或真实窗口视觉验收通过。',
  'diagnostics.empty': '本进程尚无诊断记录。',
  'diagnostics.build': '本地构建',
  'diagnostics.flags': '已生效设置',
  'diagnostics.enabled': '连续情绪',
  'diagnostics.quiet': '勿扰',
  'diagnostics.on': '开',
  'diagnostics.off': '关',
  'diagnostics.state': '当前状态',
  'diagnostics.valence': '效价',
  'diagnostics.arousal': '活跃度',
  'diagnostics.accepted': '接受',
  'diagnostics.ignored': '忽略或拦截',
  'diagnostics.before': '变化前',
  'diagnostics.after': '变化后',
  'diagnostics.strategy': '表达策略',
  'diagnostics.animation': '动画选择',
  'diagnostics.fallback': '保持现有动画或仅显示文字',
  'diagnostics.calm': '平静',
  'diagnostics.cheerful': '轻快',
  'diagnostics.subdued': '低落但克制',
  'diagnostics.event': '情绪事件',
  'diagnostics.expression': '表达',
  'diagnostics.proactive': '主动互动',
  'diagnostics.lifecycle': '生命周期',
};

export const emotionDiagnosticsEn = {
  'diagnostics.title': 'Local emotion diagnostics',
  'diagnostics.show': 'Show local emotion diagnostics',
  'diagnostics.hide': 'Hide local emotion diagnostics',
  'diagnostics.refresh': 'Refresh diagnostics',
  'diagnostics.loading': 'Loading local diagnostics…',
  'diagnostics.error': 'Could not load diagnostics. Refresh to retry.',
  'diagnostics.forbidden':
    'Diagnostics are limited to a local, same-origin interface. Open settings in the local DeepSeek Harness.',
  'diagnostics.note':
    'Up to 80 records per pet in this process; cleared on restart. No chat text, full prompts or keys are recorded. Program diagnostics do not verify model response quality or the appearance of a real desktop window.',
  'diagnostics.empty': 'No diagnostic records in this process yet.',
  'diagnostics.build': 'Local build',
  'diagnostics.flags': 'Active settings',
  'diagnostics.enabled': 'Continuous emotions',
  'diagnostics.quiet': 'Do not disturb',
  'diagnostics.on': 'on',
  'diagnostics.off': 'off',
  'diagnostics.state': 'Current state',
  'diagnostics.valence': 'valence',
  'diagnostics.arousal': 'arousal',
  'diagnostics.accepted': 'accepted',
  'diagnostics.ignored': 'ignored or blocked',
  'diagnostics.before': 'before',
  'diagnostics.after': 'after',
  'diagnostics.strategy': 'Expression strategy',
  'diagnostics.animation': 'Animation selection',
  'diagnostics.fallback': 'Keep existing animation or use text only',
  'diagnostics.calm': 'calm',
  'diagnostics.cheerful': 'cheerful',
  'diagnostics.subdued': 'subdued, restrained',
  'diagnostics.event': 'emotion event',
  'diagnostics.expression': 'expression',
  'diagnostics.proactive': 'proactive interaction',
  'diagnostics.lifecycle': 'lifecycle',
};

const CODE_LABELS: Record<string, readonly [string, string]> = {
  'state-loaded': ['载入持久化情绪', 'persistent emotion loaded'],
  'time-decay': ['随时间回归基线', 'return toward baseline'],
  'user-message': ['收到用户消息', 'user message observed'],
  'host-turn-completed': ['宿主回合完成', 'host turn completed'],
  'host-execution-failed': ['宿主执行失败', 'host execution failed'],
  'host-event': ['宿主事件', 'host event'],
  'quiet-mode': ['勿扰规则', 'do not disturb rule'],
  'manual-whisper': ['手动碎碎念', 'manual whisper'],
  'automatic-whisper': ['自动碎碎念', 'automatic whisper'],
  'not-direct-praise': ['不是对桌宠的直接夸奖', 'not direct praise to the pet'],
  'unobserved-event': ['没有可用的真实结果事件', 'no observable outcome event'],
  'missing-session': ['缺少可识别会话', 'missing identifiable session'],
  'session-completion-limit': ['本会话完成事件已达上限', 'session completion event limit reached'],
  'unknown-pet': ['没有找到该宠物', 'pet not found'],
  'period-not-due': ['尚未到自动互动周期', 'automatic interaction period not due'],
  'generation-failed': ['生成失败', 'generation failed'],
  'pet-removed': ['宠物已移除', 'pet removed'],
  'content-repeat': ['近期碎碎念内容重复', 'recent whisper content repeated'],
  'content-empty': ['生成内容为空', 'empty generated content'],
  planned: ['已选择表达策略', 'expression strategy selected'],
  'neutral-chat': ['自然平静，不加情绪负担', 'natural and calm'],
  'warm-chat': ['稍带轻快，保持克制', 'warm and restrained'],
  'supportive-chat': ['平和支持，不虚构用户状态', 'supportive without inferring user state'],
  technical: ['技术回答准确完整优先', 'technical accuracy and completeness first'],
  praise: ['直接夸奖', 'direct praise'],
  'task-completed': ['宿主回合完成', 'host turn completed'],
  'task-failed': ['宿主回合失败', 'host turn failed'],
  'do-not-disturb': ['开启勿扰', 'do not disturb enabled'],
  chat: ['人工聊天', 'manual chat'],
  whisper: ['碎碎念', 'whisper'],
  reset: ['重置状态', 'state reset'],
  startup: ['本进程启动', 'process started'],
  decay: ['随时间回归基线', 'return toward baseline'],
  applied: ['事件已应用', 'event applied'],
  accepted: ['已接受', 'accepted'],
  duplicate: ['重复事件', 'duplicate event'],
  'duplicate-event': ['重复事件', 'duplicate event'],
  'invalid-event': ['无效事件', 'invalid event'],
  'feature-disabled': ['连续情绪已关闭', 'continuous emotions disabled'],
  'emotion-disabled': ['连续情绪已关闭', 'continuous emotions disabled'],
  disabled: ['功能已关闭', 'feature disabled'],
  cooldown: ['主动互动仍在冷却', 'proactive cooldown active'],
  'in-flight': ['已有生成进行中', 'generation already in progress'],
  'pet-disabled': ['该宠物已关闭自动碎碎念', 'automatic whispers disabled for this pet'],
  'work-active': ['宿主仍在工作', 'host work active'],
  working: ['宿主仍在工作', 'host work active'],
  'policy-changed': ['生成期间设置已变化', 'policy changed during generation'],
  superseded: ['已被新互动取代', 'superseded by a newer interaction'],
  'duplicate-content': ['近期碎碎念内容重复', 'recent whisper content repeated'],
  'content-duplicate': ['近期碎碎念内容重复', 'recent whisper content repeated'],
  'generate-error': ['生成失败', 'generation failed'],
  published: ['已提交表达', 'expression published'],
  reserved: ['已预留本次主动互动', 'proactive interaction reserved'],
  calm: ['自然平静', 'natural and calm'],
  cheerful: ['轻快克制', 'cheerful and restrained'],
  subdued: ['平和支持', 'calm and supportive'],
  'quiet-companion': ['安静陪伴', 'quiet companionship'],
  'technical-focused': ['技术回答优先', 'technical answer first'],
};

interface Snapshot {
  valence: number;
  arousal: number;
  label: 'calm' | 'cheerful' | 'subdued';
}
interface DiagnosticRecord {
  seq: number;
  ts: number;
  category: string;
  event: string;
  accepted: boolean;
  reason: string;
  before?: Snapshot;
  after?: Snapshot;
  strategy?: string;
  animation?: string | null;
}
interface Report {
  enabled: boolean;
  doNotDisturb: boolean;
  state: Snapshot;
  build: { id: string; version: string };
  records: DiagnosticRecord[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const code = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9.-]{0,79}$/u.test(value);
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const snapshot = (value: unknown): Snapshot | undefined =>
  object(value) &&
  numeric(value.valence) &&
  numeric(value.arousal) &&
  value.valence >= -1 &&
  value.valence <= 1 &&
  value.arousal >= 0 &&
  value.arousal <= 1 &&
  (value.label === 'calm' || value.label === 'cheerful' || value.label === 'subdued')
    ? { valence: value.valence, arousal: value.arousal, label: value.label }
    : undefined;

/** Copy a fixed, bounded field set; unexpected response fields never enter component state. */
function parseReport(value: unknown): Report {
  if (
    !object(value) ||
    value.ok !== true ||
    typeof value.enabled !== 'boolean' ||
    typeof value.doNotDisturb !== 'boolean' ||
    !object(value.build) ||
    !code(value.build.id) ||
    typeof value.build.version !== 'string' ||
    !/^[0-9][a-z0-9.+-]{0,79}$/u.test(value.build.version) ||
    !object(value.diagnostics) ||
    value.diagnostics.capacity !== 80 ||
    value.diagnostics.lifetime !== 'process' ||
    !Array.isArray(value.diagnostics.records)
  ) {
    throw new Error('Invalid diagnostics');
  }
  const state = snapshot(value.state);
  if (!state) throw new Error('Invalid diagnostics');
  const records: DiagnosticRecord[] = [];
  for (const item of value.diagnostics.records.slice(-80)) {
    if (
      !object(item) ||
      !Number.isSafeInteger(item.seq) ||
      !numeric(item.ts) ||
      item.ts < 0 ||
      !['event', 'expression', 'proactive', 'lifecycle'].includes(String(item.category)) ||
      !code(item.event) ||
      !code(item.reason) ||
      typeof item.accepted !== 'boolean'
    )
      continue;
    const record: DiagnosticRecord = {
      seq: item.seq as number,
      ts: item.ts,
      category: item.category as string,
      event: item.event,
      accepted: item.accepted,
      reason: item.reason,
      before: snapshot(item.before),
      after: snapshot(item.after),
    };
    if (code(item.strategy)) record.strategy = item.strategy;
    if (item.animation === null) record.animation = null;
    else if (
      typeof item.animation === 'string' &&
      item.animation.length <= 120 &&
      ![...item.animation].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      record.animation = item.animation;
    records.push(record);
  }
  return {
    enabled: value.enabled,
    doNotDisturb: value.doNotDisturb,
    state,
    build: { id: value.build.id, version: value.build.version },
    records,
  };
}

export function makeEmotionDiagnosticsSection(rt: {
  h: typeof jsx;
  useState: <T>(init: T) => [T, Dispatch<SetStateAction<T>>];
  useEffect: (effect: EffectCallback, deps?: DependencyList) => void;
  t: (key: string) => string;
}) {
  const { h, useState, useEffect, t } = rt;
  const tr = (key: string) => t('diagnostics.' + key);
  const explain = (value: string): string =>
    CODE_LABELS[value]?.[tr('title') === 'Local emotion diagnostics' ? 1 : 0] ?? value;
  const describe = (value: Snapshot) =>
    `${tr(value.label)} · ${tr('valence')} ${value.valence.toFixed(2)} / ${tr('arousal')} ${value.arousal.toFixed(2)}`;
  return function EmotionDiagnostics({ petId }: { petId: string }) {
    const [open, setOpen] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const [result, setResult] = useState<{ petId: string; report: Report } | null>(null);
    const [status, setStatus] = useState<'idle' | 'loading' | 'error' | 'forbidden'>('idle');
    useEffect(() => {
      if (!open || !petId) return;
      const controller = new AbortController();
      let alive = true;
      setStatus('loading');
      setResult(null);
      fetch('/dsh-pet-7340/emotion?pet=' + encodeURIComponent(petId) + '&diagnostics=1', {
        headers: { 'X-Dsh-Pet-Diagnostics': '1' },
        cache: 'no-store',
        referrerPolicy: 'origin',
        signal: controller.signal,
      })
        .then(async (response) => {
          if (response.status === 403) {
            if (alive) setStatus('forbidden');
            return;
          }
          if (!response.ok) throw new Error('Diagnostics unavailable');
          const report = parseReport(await response.json());
          if (alive) {
            setResult({ petId, report });
            setStatus('idle');
          }
        })
        .catch(() => {
          if (alive) setStatus('error');
        });
      return () => {
        alive = false;
        controller.abort();
      };
    }, [open, petId, attempt]);
    const report = result?.petId === petId ? result.report : null;
    const line = (label: string, value: string, key: string) => h('div', { key, children: `${label}：${value}` });
    return h('section', {
      className: 'dsh-pet-cfg__card dsh-pet-diagnostics',
      'aria-label': tr('title'),
      style: { minWidth: 0, overflowWrap: 'anywhere', fontSize: '12px', lineHeight: '20px' },
      children: [
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dsh-pet-cfg__btn',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
          children: tr(open ? 'hide' : 'show'),
        }),
        open
          ? h('div', {
              key: 'content',
              children: [
                h('p', { key: 'note', className: 'dsh-pet-cfg__note', children: tr('note') }),
                h('button', {
                  key: 'refresh',
                  type: 'button',
                  className: 'dsh-pet-cfg__btn',
                  disabled: !petId || status === 'loading',
                  onClick: () => setAttempt((value) => value + 1),
                  children: tr('refresh'),
                }),
                status === 'loading' ? h('p', { key: 'loading', role: 'status', children: tr('loading') }) : null,
                status === 'error' || status === 'forbidden'
                  ? h('p', { key: 'error', role: 'alert', children: tr(status) })
                  : null,
                report
                  ? h('div', {
                      key: 'report',
                      children: [
                        line(tr('build'), report.build.id + ' / ' + report.build.version, 'build'),
                        line(
                          tr('flags'),
                          `${tr('enabled')} ${tr(report.enabled ? 'on' : 'off')} · ${tr('quiet')} ${tr(report.doNotDisturb ? 'on' : 'off')}`,
                          'flags',
                        ),
                        line(tr('state'), describe(report.state), 'state'),
                        report.records.length === 0
                          ? h('p', { key: 'empty', children: tr('empty') })
                          : h('ol', {
                              key: 'records',
                              'aria-label': tr('title'),
                              style: { maxHeight: '400px', overflowY: 'auto', paddingInlineStart: '24px' },
                              children: [...report.records].reverse().map((record) =>
                                h('li', {
                                  key: record.seq,
                                  style: { margin: '10px 0' },
                                  children: [
                                    line(
                                      `#${record.seq} · ${new Date(record.ts).toLocaleTimeString()} · ${tr(record.category)}`,
                                      explain(record.event),
                                      'event',
                                    ),
                                    line(
                                      tr(record.accepted ? 'accepted' : 'ignored'),
                                      explain(record.reason),
                                      'reason',
                                    ),
                                    record.before ? line(tr('before'), describe(record.before), 'before') : null,
                                    record.after ? line(tr('after'), describe(record.after), 'after') : null,
                                    record.strategy ? line(tr('strategy'), explain(record.strategy), 'strategy') : null,
                                    record.animation !== undefined
                                      ? line(tr('animation'), record.animation ?? tr('fallback'), 'animation')
                                      : null,
                                  ],
                                }),
                              ),
                            }),
                      ],
                    })
                  : null,
              ],
            })
          : null,
      ],
    });
  };
}
