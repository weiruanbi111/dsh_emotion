/** Short-lived automatic-whisper fingerprints; never stores message text or prompt content. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type WhisperContentCheck =
  { accepted: true; reason: 'content-new' } | { accepted: false; reason: 'content-repeat' | 'content-empty' };

interface Fingerprint {
  hash: string;
  at: number;
}

const WINDOW_MS = 30 * 60 * 1000;
const PER_PET_LIMIT = 16;
const PET_LIMIT = 128;
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function fingerprint(text: string): string | null {
  // Keep symbols (including emoji) and word order: this is exact normalized matching, not semantic matching.
  const normalized = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{White_Space}\uFEFF]/gu, '');
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

/** Only automatic speech should use this store. Manual chat and manual whispers bypass it entirely. */
export class WhisperContentStore {
  declare private readonly filePath: string;
  declare private readonly now: () => number;
  declare private readonly pets: Map<string, Fingerprint[]>;
  declare private highWaterTime: number;
  declare private writeSequence: number;
  declare private preserveOriginal: boolean;

  constructor(filePath: string, now: () => number = Date.now) {
    this.filePath = filePath;
    this.now = now;
    this.pets = new Map();
    this.highWaterTime = 0;
    this.writeSequence = 0;
    this.preserveOriginal = false;
    const boundedOnLoad = this.load();
    const expired = this.prune();
    if (boundedOnLoad || expired) this.save();
  }

  private time(): number {
    const value = this.now();
    this.highWaterTime = Math.max(this.highWaterTime, isTime(value) ? value : Date.now());
    return this.highWaterTime;
  }

  private prune(): boolean {
    const now = this.time();
    let changed = false;
    for (const [petId, list] of this.pets) {
      const retained = list.filter((entry) => now - entry.at < WINDOW_MS);
      if (retained.length !== list.length || !retained.length) changed = true;
      if (retained.length) this.pets.set(petId, retained);
      else this.pets.delete(petId);
    }
    return changed;
  }

  /** Compares only; a check never remembers the candidate. It may remove expired metadata. */
  check(petId: string, text: string): WhisperContentCheck {
    if (this.prune()) this.save();
    const hash = fingerprint(text);
    if (hash === null) return { accepted: false, reason: 'content-empty' };
    return this.pets.get(petId)?.some((entry) => entry.hash === hash)
      ? { accepted: false, reason: 'content-repeat' }
      : { accepted: true, reason: 'content-new' };
  }

  /** Call only after the existing commit guards pass and the automatic line is actually published. */
  remember(petId: string, text: string): boolean {
    if (!this.check(petId, text).accepted) return false;
    const list = this.pets.get(petId) ?? [];
    list.push({ hash: fingerprint(text)!, at: this.time() });
    if (list.length > PER_PET_LIMIT) list.splice(0, list.length - PER_PET_LIMIT);
    // Successful publications make this pet the most recently used bucket.
    this.pets.delete(petId);
    this.pets.set(petId, list);
    while (this.pets.size > PET_LIMIT) this.pets.delete(this.pets.keys().next().value as string);
    this.save();
    return true;
  }

  private load(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preserveOriginal = true;
        console.warn('dsh-pet: whisper fingerprints could not be read; continuing in memory.');
      }
      return false;
    }
    try {
      const data: unknown = JSON.parse(raw);
      if (!isObject(data) || data.version !== 1 || !Array.isArray(data.pets)) throw new Error('invalid fingerprints');
      const loaded = new Map<string, Fingerprint[]>();
      let bounded = false;
      for (const pet of data.pets) {
        if (
          !isObject(pet) ||
          typeof pet.id !== 'string' ||
          pet.id.trim() === '' ||
          pet.id.length > 512 ||
          !Array.isArray(pet.entries)
        )
          throw new Error('invalid fingerprint bucket');
        const list: Fingerprint[] = [];
        for (const entry of pet.entries) {
          if (
            !isObject(entry) ||
            typeof entry.hash !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.hash) ||
            !isTime(entry.at)
          )
            throw new Error('invalid fingerprint entry');
          list.push({ hash: entry.hash, at: entry.at });
        }
        const retained = list.slice(-PER_PET_LIMIT);
        if (retained.length !== list.length || loaded.has(pet.id)) bounded = true;
        loaded.delete(pet.id);
        loaded.set(pet.id, retained);
        while (loaded.size > PET_LIMIT) {
          loaded.delete(loaded.keys().next().value as string);
          bounded = true;
        }
      }
      for (const [petId, list] of loaded) {
        this.pets.set(petId, list);
        for (const entry of list) this.highWaterTime = Math.max(this.highWaterTime, entry.at);
      }
      return bounded;
    } catch {
      console.warn('dsh-pet: invalid whisper fingerprints were preserved; starting an empty short-term window.');
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`);
      } catch {
        this.preserveOriginal = true;
        console.warn('dsh-pet: whisper fingerprint preservation failed; continuing in memory.');
      }
      return false;
    }
  }

  private save(): void {
    if (this.preserveOriginal) return;
    const temporary = `${this.filePath}.tmp-${process.pid}-${++this.writeSequence}`;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(
        temporary,
        JSON.stringify({ version: 1, pets: [...this.pets].map(([id, entries]) => ({ id, entries })) }),
        { encoding: 'utf8', flag: 'wx' },
      );
      renameSync(temporary, this.filePath);
    } catch {
      console.warn('dsh-pet: whisper fingerprints could not be saved; continuing in memory.');
      try {
        unlinkSync(temporary);
      } catch {
        /* The temporary file may not have been created. */
      }
    }
  }
}
