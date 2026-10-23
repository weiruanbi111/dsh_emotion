import { createHash } from 'node:crypto';

/** Only a short, direct compliment to the pet is observed; quoted stories and model text are ignored. */
export function isExplicitPraise(text: string): boolean {
  return /^(?:你(?:做得)?(?:真|真的|太)?(?:棒|厉害|可爱|贴心|能干)|你(?:做得(?:真)?|真|真的|太)好|做得(?:真)?好|干得(?:真)?漂亮)[了呀啊哦呢!！。~～\s]*$/u.test(
    text.trim(),
  );
}

/** No user text is persisted as an event id. Repeated transport submissions share a five-minute window. */
export function praiseEventId(text: string, now: number): string {
  return 'praise:' + createHash('sha256').update(text.trim()).digest('hex') + ':' + Math.floor(now / 300_000);
}

/** These describe host execution outcomes, never a guess made from the assistant's reply. */
export function observedWorkEmotion(
  event: { type?: string; seq?: unknown; data?: { reason?: { kind?: string } } },
  state: string | null,
): 'task-completed' | 'task-failed' | null {
  if (event.type !== 'turn/end' || !Number.isSafeInteger(event.seq) || Number(event.seq) <= 0) return null;
  const kind = event.data?.reason?.kind;
  if (kind === 'completed' && state === 'success') return 'task-completed';
  if (kind === 'error' || kind === 'timeout' || kind === 'max-tokens') return 'task-failed';
  return null;
}

export function proactivePeriodSec(base: number, label: string): number {
  const safe = Number.isFinite(base) && base > 0 ? base : 300;
  return Math.max(300, safe * (label === 'subdued' ? 1.5 : 1));
}
