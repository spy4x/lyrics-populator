// Per-source rate limiter. Different APIs have different quotas:
//   - MusicBrainz: 1 req/sec unauthenticated
//   - LRCLib: ~1 req/sec, may 503 on bursts
//   - Cover Art Archive: same as MusicBrainz (same network)
//   - lyrics.ovh: no documented limit but be polite
//
// The RateLimiter wraps a single shared mutex + tracks last-request timestamp.
// Multiple concurrent callers will serialize through acquire(), but each only
// waits until enough time has passed since the last acquire().

export class RateLimiter {
  private lastAt = 0
  private readonly intervalMs: number

  constructor(opts: { requestsPerSecond: number }) {
    if (opts.requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be > 0")
    }
    this.intervalMs = Math.max(1, Math.round(1000 / opts.requestsPerSecond))
  }

  // Wait until it's safe to make another request, then mark this one as taken.
  async acquire(): Promise<void> {
    while (true) {
      const now = Date.now()
      const due = this.lastAt + this.intervalMs
      if (now >= due) {
        this.lastAt = now
        return
      }
      const wait = due - now
      // Yield to event loop so other microtasks can run, then re-check.
      await new Promise((r) => setTimeout(r, wait))
    }
  }
}
