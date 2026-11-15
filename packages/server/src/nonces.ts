/**
 * Nonces this server has accepted, kept until the payment they belong to
 * expires. In memory only: a restart forgets them (docs/threat-model.md).
 */
export class NonceCache {
  private readonly entries = new Map<string, number>();

  /** Reserve a nonce; false when it is already held. */
  claim(payer: string, nonce: string, expiresAt: number, now: number): boolean {
    this.prune(now);
    const key = `${payer.toLowerCase()}:${nonce.toLowerCase()}`;
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAt);
    return true;
  }

  release(payer: string, nonce: string): void {
    this.entries.delete(`${payer.toLowerCase()}:${nonce.toLowerCase()}`);
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
