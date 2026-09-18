import { assertEquals } from "@std/assert"
import { RateLimiter } from "./rate-limiter.ts"

Deno.test("RateLimiter allows first call immediately", async () => {
  const rl = new RateLimiter({ requestsPerSecond: 2 })
  const t0 = Date.now()
  await rl.acquire()
  assertEquals(Date.now() - t0 < 50, true, "first acquire should be instant")
})

Deno.test("RateLimiter throttles bursts to configured rate", async () => {
  const rl = new RateLimiter({ requestsPerSecond: 4 }) // 250ms each
  const t0 = Date.now()
  await rl.acquire()
  await rl.acquire()
  await rl.acquire()
  await rl.acquire()
  const elapsed = Date.now() - t0
  // 4 calls at 250ms each → ~750ms minimum
  assertEquals(elapsed >= 700, true, `expected >=700ms, got ${elapsed}`)
  assertEquals(elapsed < 1500, true, `expected <1500ms, got ${elapsed}`)
})

Deno.test("RateLimiter handles concurrent callers", async () => {
  const rl = new RateLimiter({ requestsPerSecond: 5 }) // 200ms each
  const t0 = Date.now()
  await Promise.all([
    rl.acquire(),
    rl.acquire(),
    rl.acquire(),
    rl.acquire(),
    rl.acquire(),
  ])
  const elapsed = Date.now() - t0
  // 5 sequential slots at 200ms each → ~800ms minimum
  assertEquals(elapsed >= 750, true, `expected >=750ms, got ${elapsed}`)
})

Deno.test("RateLimiter rejects invalid config", () => {
  let err = ""
  try {
    new RateLimiter({ requestsPerSecond: 0 })
  } catch (e) {
    err = (e as Error).message
  }
  assertEquals(err.includes("must be > 0"), true)
})
