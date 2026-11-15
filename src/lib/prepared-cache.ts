// Default for how long a smile is remembered (the "Remember smiles" setting can change it).
export const SMILE_MEMORY_MS = 3000;
// A non-smiling photo older than this is too stale to send; independent of smile memory.
export const PHOTO_FRESH_MS = 3000;

// At most two completed GIFs, plus the single frame currently being encoded.
export class PreparedCache<T extends { at: number; smiling: boolean }> {
  generation = 0;
  memoryMs = SMILE_MEMORY_MS;
  private smile: T | null = null;
  private latest: T | null = null;
  private neutral: T | null = null;
  private typedAt = -Infinity;

  clear() {
    this.generation++;
    this.smile = this.latest = this.neutral = null;
    this.typedAt = -Infinity;
  }

  forget() {
    this.generation++;
    this.smile = null;
    if (this.latest?.smiling) this.latest = null;
    this.typedAt = -Infinity;
  }

  remembered(now: number) {
    if (this.smile && now >= Math.max(this.smile.at, this.typedAt) + this.memoryMs) this.smile = null;
    return this.smile;
  }

  typed(now: number) {
    // Keystrokes extend an existing smile, never resurrect an expired one.
    if (this.remembered(now)) this.typedAt = now;
  }

  publish(value: T, generation: number) {
    if (generation !== this.generation) return false;
    this.latest = value;
    if (value.smiling) this.smile = value;
    else this.neutral = value;
    return true;
  }

  ready(now: number, remember: boolean): { photo: T; remembered: boolean } | null {
    const smile = remember ? this.remembered(now) : null;
    if (smile) return { photo: smile, remembered: true };
    const candidate = this.latest && (!remember || !this.latest.smiling) ? this.latest : this.neutral;
    return candidate && now < candidate.at + PHOTO_FRESH_MS ? { photo: candidate, remembered: false } : null;
  }
}
