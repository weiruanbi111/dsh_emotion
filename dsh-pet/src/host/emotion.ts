/** Continuous, simulated pet emotion. Observations enter here; model guesses never do. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

export type EmotionEventKind = 'praise' | 'task-completed' | 'task-failed' | 'do-not-disturb';
export interface EmotionSnapshot {
  valence: number;
  arousal: number;
  updatedAt: number;
  label: 'calm' | 'cheerful' | 'subdued';
}

interface EmotionRecord {
  valence: number;
  arousal: number;
  updatedAt: number;
  eventIds: string[];
  proactiveIds: string[];
  lastProactiveAt: number | null;
  lastInteractionAt: number | null;
  lastEvent: EmotionEventKind | null;
  completionWindows: CompletionWindow[];
}

interface CompletionWindow {
  source: string;
  startedAt: number;
  count: number;
}
const COMPLETION_WINDOW_MS = 10 * 60 * 1000;
const COMPLETIONS_PER_WINDOW = 3;
const COMPLETION_SOURCES_LIMIT = 32;
export type HostCompletionResult = 'accepted' | 'invalid-event' | 'duplicate-event' | 'session-completion-limit';

const BASE_AROUSAL = 0.35;
const HALF_LIFE_MS = 30 * 60 * 1000;
const RECENT_IDS_LIMIT = 128;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;
const DELTAS: Record<EmotionEventKind, readonly [number, number]> = {
  praise: [0.28, 0.12],
  // A host turn ending is weaker evidence than an explicit compliment, not a confirmed user outcome.
  'task-completed': [0.08, 0.04],
  'task-failed': [-0.22, 0.08],
  'do-not-disturb': [0, -0.2],
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isEventId = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && value.length <= 512;
const isEventKind = (value: unknown): value is EmotionEventKind =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(DELTAS, value);

function remember(ids: string[], eventId: string): void {
  ids.push(eventId);
  if (ids.length > RECENT_IDS_LIMIT) ids.splice(0, ids.length - RECENT_IDS_LIMIT);
}

function decay(record: EmotionRecord, now: number): EmotionRecord {
  // A clock correction cannot grow emotion or move its timestamp backwards.
  const updatedAt = Math.max(now, record.updatedAt);
  const factor = 2 ** (-(updatedAt - record.updatedAt) / HALF_LIFE_MS);
  return {
    ...record,
    valence: clamp(record.valence * factor, -1, 1),
    arousal: clamp(BASE_AROUSAL + (record.arousal - BASE_AROUSAL) * factor, 0, 1),
    updatedAt,
  };
}

function snapshotOf(record: EmotionRecord): EmotionSnapshot {
  return {
    valence: record.valence,
    arousal: record.arousal,
    updatedAt: record.updatedAt,
    label: record.valence >= 0.15 ? 'cheerful' : record.valence <= -0.15 ? 'subdued' : 'calm',
  };
}

/** One store per host process. Synchronous reservations happen before any model await. */
export class EmotionStore {
  declare private readonly filePath: string;
  declare private readonly now: () => number;
  declare private readonly pets: Map<string, EmotionRecord>;
  declare private writeSequence: number;
  declare private preserveOriginal: boolean;

  constructor(filePath: string, now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
    this.pets = new Map();
    this.writeSequence = 0;
    this.preserveOriginal = false;
    this.load();
  }

  private time(): number {
    const value = this.now();
    return isTime(value) ? value : Date.now();
  }

  private record(petId: string): EmotionRecord {
    const current = this.pets.get(petId);
    return (
      current ?? {
        valence: 0,
        arousal: BASE_AROUSAL,
        updatedAt: this.time(),
        eventIds: [],
        proactiveIds: [],
        lastProactiveAt: null,
        lastInteractionAt: null,
        lastEvent: null,
        completionWindows: [],
      }
    );
  }

  snapshot(petId: string): EmotionSnapshot {
    return snapshotOf(decay(this.record(petId), this.time()));
  }

  apply(petId: string, kind: EmotionEventKind, eventId: string): boolean {
    if (!isEventId(eventId) || !Object.prototype.hasOwnProperty.call(DELTAS, kind)) return false;
    const record = decay(this.record(petId), this.time());
    if (record.eventIds.includes(eventId)) return false;
    const [valence, arousal] = DELTAS[kind];
    record.valence = clamp(record.valence + valence, -1, 1);
    record.arousal = clamp(record.arousal + arousal, 0, 1);
    record.lastEvent = kind;
    remember(record.eventIds, eventId);
    this.pets.set(petId, record);
    this.save();
    return true;
  }

  /** Short-lived execution metadata only. A repeated session cannot saturate mood by ending turns. */
  applyHostCompletion(petId: string, eventId: string, sessionId: string): HostCompletionResult {
    if (!isEventId(eventId) || !isEventId(sessionId) || sessionId === 'unknown') return 'invalid-event';
    const record = decay(this.record(petId), this.time());
    if (record.eventIds.includes(eventId)) return 'duplicate-event';
    const now = record.updatedAt;
    record.completionWindows = record.completionWindows.filter((entry) => now - entry.startedAt < COMPLETION_WINDOW_MS);
    const source = createHash('sha256').update(sessionId).digest('hex');
    let window = record.completionWindows.find((entry) => entry.source === source);
    if (!window) {
      window = { source, startedAt: now, count: 0 };
      record.completionWindows.push(window);
      record.completionWindows = record.completionWindows.slice(-COMPLETION_SOURCES_LIMIT);
    }
    const allowed = window.count < COMPLETIONS_PER_WINDOW;
    if (allowed) window.count++;
    this.pets.set(petId, record);
    if (allowed) {
      this.apply(petId, 'task-completed', eventId);
      return 'accepted';
    }
    // Remember even ignored transport IDs so they cannot be replayed when the window expires.
    remember(record.eventIds, eventId);
    this.save();
    return 'session-completion-limit';
  }

  /** Reserve before generation: a failed request still consumes its cooldown and event ID. */
  proactiveBlockReason(
    petId: string,
    eventId: string,
    cooldownMs = DEFAULT_COOLDOWN_MS,
  ): 'invalid-event' | 'duplicate-event' | 'cooldown' | null {
    if (!isEventId(eventId)) return 'invalid-event';
    const record = this.record(petId);
    if (record.proactiveIds.includes(eventId)) return 'duplicate-event';
    const cooldown = Number.isFinite(cooldownMs) ? Math.max(0, cooldownMs) : DEFAULT_COOLDOWN_MS;
    const lastActivity = Math.max(record.lastProactiveAt ?? -Infinity, record.lastInteractionAt ?? -Infinity);
    return Number.isFinite(lastActivity) && this.time() - lastActivity < cooldown ? 'cooldown' : null;
  }

  reserveProactive(petId: string, eventId: string, cooldownMs = DEFAULT_COOLDOWN_MS): boolean {
    if (this.proactiveBlockReason(petId, eventId, cooldownMs)) return false;
    const now = this.time();
    const record = decay(this.record(petId), now);
    record.lastProactiveAt = now;
    remember(record.proactiveIds, eventId);
    this.pets.set(petId, record);
    this.save();
    return true;
  }

  /** User initiated interaction also starts the persistent automatic-interaction cooldown. */
  noteInteraction(petId: string): void {
    const now = this.time();
    const record = decay(this.record(petId), now);
    record.lastInteractionAt = Math.max(now, record.lastInteractionAt ?? now);
    this.pets.set(petId, record);
    this.save();
  }

  /** Reset emotion and event history; keep the last reservation to prevent cooldown bypass. */
  reset(petId?: string): void {
    const ids = petId === undefined ? [...this.pets.keys()] : [petId];
    for (const id of ids) {
      const record = this.record(id);
      this.pets.set(id, {
        valence: 0,
        arousal: BASE_AROUSAL,
        updatedAt: Math.max(this.time(), record.updatedAt),
        eventIds: [],
        proactiveIds: [],
        lastProactiveAt: record.lastProactiveAt,
        lastInteractionAt: record.lastInteractionAt,
        lastEvent: null,
        completionWindows: [],
      });
    }
    this.save();
  }

  context(petId: string): string {
    const snapshot = this.snapshot(petId);
    const tone = {
      calm: '平静自然，简短温和',
      cheerful: '轻快开心，可以稍带俏皮，避免过度兴奋',
      subdued: '稍显低落但平和克制，面对问题给予支持，不责怪用户',
    }[snapshot.label];
    const lastEvent = this.record(petId).lastEvent;
    const observed =
      lastEvent === null
        ? '尚无'
        : {
            praise: '用户明确夸奖桌宠',
            'task-completed': '宿主明确上报回合完成，仅代表执行回合结束，不是用户确认的成果',
            'task-failed': '宿主明确上报执行错误',
            'do-not-disturb': '用户开启勿扰',
          }[lastEvent];
    return (
      '[桌宠情绪上下文] 这是桌宠自身的模拟状态，不是用户的情绪或状态，也不是对用户状态的推测。\n' +
      `当前心情倾向：${tone}。情绪效价 ${snapshot.valence.toFixed(2)}，活跃度 ${snapshot.arousal.toFixed(2)}。这只是背景，当前情境与事实优先。\n` +
      `上次记录的明确事件：${observed}（历史记录，不代表仍在发生）。这不能证明任务产出的真实质量，也不能据此断言用户的心情或需求。\n` +
      '只按明确提供的事实回应，不虚构用户正在工作、疲惫、离开或需要安慰。' +
      '不因用户离开或未回复而难过、责怪或惩罚用户；不用内疚、孤独或亏欠话术索取互动，也不要求回复。'
    );
  }

  private load(): void {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('dsh-pet: emotion state could not be read; continuing with in-memory state.');
        this.preserveOriginal = true;
      }
      return;
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!isObject(data) || data.version !== 1 || !isObject(data.pets)) throw new Error('invalid emotion state');
      const loaded = new Map<string, EmotionRecord>();
      for (const [petId, value] of Object.entries(data.pets)) {
        if (
          !isObject(value) ||
          typeof value.valence !== 'number' ||
          !Number.isFinite(value.valence) ||
          typeof value.arousal !== 'number' ||
          !Number.isFinite(value.arousal) ||
          !isTime(value.updatedAt) ||
          !Array.isArray(value.eventIds) ||
          !value.eventIds.every(isEventId) ||
          !Array.isArray(value.proactiveIds) ||
          !value.proactiveIds.every(isEventId) ||
          !(value.lastProactiveAt === null || isTime(value.lastProactiveAt)) ||
          !(
            value.lastInteractionAt === undefined ||
            value.lastInteractionAt === null ||
            isTime(value.lastInteractionAt)
          ) ||
          !(value.lastEvent === undefined || value.lastEvent === null || isEventKind(value.lastEvent))
        ) {
          throw new Error('invalid emotion record');
        }
        loaded.set(petId, {
          valence: clamp(value.valence, -1, 1),
          arousal: clamp(value.arousal, 0, 1),
          updatedAt: value.updatedAt,
          eventIds: value.eventIds.slice(-RECENT_IDS_LIMIT),
          proactiveIds: value.proactiveIds.slice(-RECENT_IDS_LIMIT),
          lastProactiveAt: value.lastProactiveAt,
          lastInteractionAt: value.lastInteractionAt ?? null,
          lastEvent: value.lastEvent ?? null,
          // Optional, expiring policy metadata; v1 MVP files without it remain valid.
          completionWindows: Array.isArray(value.completionWindows)
            ? value.completionWindows
                .filter(
                  (entry): entry is CompletionWindow =>
                    isObject(entry) &&
                    typeof entry.source === 'string' &&
                    /^[a-f0-9]{64}$/u.test(entry.source) &&
                    isTime(entry.startedAt) &&
                    Number.isSafeInteger(entry.count) &&
                    Number(entry.count) >= 0 &&
                    Number(entry.count) <= COMPLETIONS_PER_WINDOW &&
                    Math.max(this.time(), value.updatedAt as number) - entry.startedAt < COMPLETION_WINDOW_MS,
                )
                .slice(-COMPLETION_SOURCES_LIMIT)
            : [],
        });
      }
      for (const [petId, record] of loaded) this.pets.set(petId, record);
    } catch {
      console.warn('dsh-pet: emotion state is invalid; preserving the original and using the baseline.');
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`);
      } catch {
        // Never overwrite a damaged file if its preservation failed.
        this.preserveOriginal = true;
        console.warn('dsh-pet: emotion state preservation failed; continuing with in-memory state.');
      }
    }
  }

  private save(): void {
    if (this.preserveOriginal) return;
    const temporary = `${this.filePath}.tmp-${process.pid}-${++this.writeSequence}`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ version: 1, pets: Object.fromEntries(this.pets) }), {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(temporary, this.filePath);
    } catch {
      console.warn('dsh-pet: emotion state could not be saved; continuing with in-memory state.');
      try {
        unlinkSync(temporary);
      } catch {
        /* The temporary file may not have been created. */
      }
    }
  }
}

/** Use configured, existing animation slots only; null lets the host keep a text-only reply. */
export function emotionAnimation(snapshot: EmotionSnapshot, conf: Record<string, unknown>): string | null {
  const animations = isObject(conf.animations) ? conf.animations : {};
  const events = isObject(animations.events) ? animations.events : {};
  const pool = snapshot.label === 'calm' ? animations.idle : events.workStatus;
  if (!Array.isArray(pool)) return null;
  const slot = pool[snapshot.label === 'calm' ? 0 : snapshot.label === 'cheerful' ? 4 : 5];
  if (typeof slot === 'string' && slot.trim() !== '') return slot;
  if (Array.isArray(slot)) {
    return slot.find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? null;
  }
  return null;
}
