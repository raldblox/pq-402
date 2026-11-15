/**
 * Nonces this server has accepted, kept until the payment they belong to
 * expires. In memory only: a restart forgets them (docs/threat-model.md).
 */
export class NonceCache {
  private readonly entries = new Map<string, number>();

  /** Reserve a payment's replay key; false when it is already held. */
  claim(key: string, expiresAt: number, now: number): boolean {
    this.prune(now);
    const k = key.toLowerCase();
    if (this.entries.has(k)) return false;
    this.entries.set(k, expiresAt);
    return true;
  }

  release(key: string): void {
    this.entries.delete(key.toLowerCase());
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }
}
