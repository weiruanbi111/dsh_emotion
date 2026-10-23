import type { IncomingMessage } from 'node:http';
import type { EmotionSnapshot } from './emotion';

export const DIAGNOSTIC_EVENTS = [
  'state-loaded',
  'time-decay',
  'user-message',
  'praise',
  'host-turn-completed',
  'host-execution-failed',
  'host-event',
  'quiet-mode',
  'reset',
  'chat',
  'manual-whisper',
  'automatic-whisper',
] as const;
export const DIAGNOSTIC_REASONS = [
  'state-loaded',
  'time-decay',
  'accepted',
  'not-direct-praise',
  'duplicate-event',
  'invalid-event',
  'unobserved-event',
  'missing-session',
  'feature-disabled',
  'session-completion-limit',
  'unknown-pet',
  'in-flight',
  'quiet-mode',
  'pet-disabled',
  'working',
  'cooldown',
  'period-not-due',
  'generation-failed',
  'pet-removed',
  'policy-changed',
  'content-repeat',
  'content-empty',
  'published',
  'planned',
  'reset',
] as const;
export const EXPRESSION_STRATEGIES = [
  'neutral-chat',
  'warm-chat',
  'supportive-chat',
  'technical',
  'quiet-companion',
  'disabled',
] as const;
type DiagnosticEvent = (typeof DIAGNOSTIC_EVENTS)[number];
type DiagnosticReason = (typeof DIAGNOSTIC_REASONS)[number];
export type ExpressionStrategy = (typeof EXPRESSION_STRATEGIES)[number];
export type DiagnosticState = Pick<EmotionSnapshot, 'valence' | 'arousal' | 'label'>;
export interface DiagnosticInput {
  category: 'event' | 'expression' | 'proactive' | 'lifecycle';
  event: DiagnosticEvent;
  accepted: boolean;
  reason: DiagnosticReason;
  before?: DiagnosticState;
  after?: DiagnosticState;
  strategy?: ExpressionStrategy;
  animation?: string | null;
}
export interface DiagnosticRecord extends DiagnosticInput {
  seq: number;
  ts: number;
}
const CAPACITY = 80;
const MAX_PETS = 128;

function stateOf(value: DiagnosticState | undefined): DiagnosticState | undefined {
  if (!value || !Number.isFinite(value.valence) || !Number.isFinite(value.arousal)) return undefined;
  if (!['calm', 'cheerful', 'subdued'].includes(value.label)) return undefined;
  return {
    valence: Math.max(-1, Math.min(1, value.valence)),
    arousal: Math.max(0, Math.min(1, value.arousal)),
    label: value.label,
  };
}

/** Process-local metadata only. Callers cannot append arbitrary strings or extra fields. */
export class EmotionDiagnostics {
  declare private readonly now: () => number;
  declare private readonly records: Map<string, DiagnosticRecord[]>;
  declare private readonly observed: Map<string, DiagnosticState>;
  declare private sequence: number;
  constructor(now: () => number = Date.now) {
    this.now = now;
    this.records = new Map();
    this.observed = new Map();
    this.sequence = 0;
  }
  record(petId: string, input: DiagnosticInput): void {
    if (!DIAGNOSTIC_EVENTS.includes(input.event) || !DIAGNOSTIC_REASONS.includes(input.reason)) return;
    if (!['event', 'expression', 'proactive', 'lifecycle'].includes(input.category)) return;
    if (!this.records.has(petId) && this.records.size >= MAX_PETS) {
      const oldest = this.records.keys().next().value as string;
      this.records.delete(oldest);
      this.observed.delete(oldest);
    }
    const before = stateOf(input.before);
    const after = stateOf(input.after);
    const strategy = input.strategy && EXPRESSION_STRATEGIES.includes(input.strategy) ? input.strategy : undefined;
    const animation =
      input.animation === null
        ? null
        : typeof input.animation === 'string'
          ? [...input.animation]
              .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
              .join('')
              .slice(0, 120)
          : undefined;
    const record: DiagnosticRecord = {
      seq: ++this.sequence,
      ts: this.now(),
      category: input.category,
      event: input.event,
      accepted: input.accepted === true,
      reason: input.reason,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
      ...(strategy ? { strategy } : {}),
      ...(animation !== undefined ? { animation } : {}),
    };
    const list = this.records.get(petId) ?? [];
    list.push(record);
    if (list.length > CAPACITY) list.splice(0, list.length - CAPACITY);
    this.records.set(petId, list);
    if (after) this.observed.set(petId, after);
  }
  observe(petId: string, state: EmotionSnapshot): void {
    const before = this.observed.get(petId);
    const after = stateOf(state)!;
    if (!before) {
      this.record(petId, {
        category: 'lifecycle',
        event: 'state-loaded',
        accepted: true,
        reason: 'state-loaded',
        after,
      });
    } else if (Math.abs(before.valence - after.valence) + Math.abs(before.arousal - after.arousal) >= 0.001) {
      this.record(petId, {
        category: 'lifecycle',
        event: 'time-decay',
        accepted: true,
        reason: 'time-decay',
        before,
        after,
      });
    }
  }
  read(petId: string): { capacity: number; lifetime: 'process'; records: DiagnosticRecord[] } {
    return {
      capacity: CAPACITY,
      lifetime: 'process',
      records: (this.records.get(petId) ?? []).map((r) => ({
        ...r,
        ...(r.before ? { before: { ...r.before } } : {}),
        ...(r.after ? { after: { ...r.after } } : {}),
      })),
    };
  }
}

/** Local-source protection, not login authentication. Legacy state-only reads remain unchanged. */
export function localDiagnosticRequest(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  verifyNativeSession?: () => boolean,
): boolean {
  const remote = req.socket?.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')) return false;
  const headers = req.headers ?? {};
  if (headers['x-dsh-pet-diagnostics'] !== '1') return false;
  const host = headers.host;
  if (typeof host !== 'string') return false;
  try {
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
    const target = new URL(protocol + '//' + host);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || target.username || target.password)
      return false;
    if (target.pathname !== '/' || target.search || target.hash) return false;
    // DSH's owned native proxy strips these HTTP source headers; Chromium may omit
    // custom-scheme Referer too. Require the host's existing signed-session/Peer check.
    if (headers.origin === undefined && headers['sec-fetch-site'] === undefined) {
      let nativeSource = headers.referer === undefined;
      if (typeof headers.referer === 'string') {
        const native = new URL(headers.referer);
        nativeSource =
          native.protocol === 'dsh-app:' &&
          native.hostname === 'app' &&
          native.port === '' &&
          !native.username &&
          !native.password &&
          native.pathname === '/' &&
          !native.search &&
          !native.hash;
      }
      return nativeSource && verifyNativeSession?.() === true;
    }
    if (headers['sec-fetch-site'] !== 'same-origin') return false;
    const source = headers.origin ?? headers.referer;
    if (typeof source !== 'string' || new URL(source).origin !== target.origin) return false;
    if (typeof headers.origin === 'string' && new URL(headers.origin).origin !== target.origin) return false;
    if (typeof headers.referer === 'string' && new URL(headers.referer).origin !== target.origin) return false;
    return true;
  } catch {
    return false;
  }
}
