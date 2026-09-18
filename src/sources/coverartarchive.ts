// Cover Art Archive client. https://coverartarchive.org — free, no auth.
// Backed by the same infrastructure as MusicBrainz, so 1 req/s rate limit applies.
import { RateLimiter } from "./rate-limiter.ts"

const caaLimiter = new RateLimiter({ requestsPerSecond: 1 })
const USER_AGENT = "lyrics-populator/0.1 ( https://github.com/spy4x/lyrics-populator )"

const BASE = "https://coverartarchive.org"

export interface CoverArtResult {
  source: "coverartarchive"
  url: string // original front cover URL
  imageBytes: Uint8Array
  mimeType: string // "image/jpeg" or "image/png"
  width: number | null
  height: number | null
  matchedScore: number // 1.0 — front cover is exact match
}

export async function coverartarchiveGetFront(
  releaseMbid: string,
): Promise<CoverArtResult | null> {
  // Step 1: JSON index to find the front cover URL
  await caaLimiter.acquire()
  const jsonUrl = `${BASE}/release/${releaseMbid}`
  const indexRes = await fetch(jsonUrl, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  })
  if (indexRes.status === 404) return null
  if (!indexRes.ok) throw new Error(`coverartarchive index ${indexRes.status}`)
  const data = await indexRes.json() as {
    images?: Array<{
      id: string
      image: string
      thumbnails?: { "250"?: string; "500"?: string; "1200"?: string }
      front: boolean
      types?: string[]
      width?: number
      height?: number
    }>
  }
  const images = data.images ?? []
  // Prefer image flagged front=true, fall back to first image
  let pick = images.find((i) => i.front)
  if (!pick) pick = images[0]
  if (!pick) return null

  // Step 2: download image bytes (skip if image is already at image URL)
  await caaLimiter.acquire()
  const imgRes = await fetch(pick.image, {
    headers: { "User-Agent": USER_AGENT },
  })
  if (!imgRes.ok) throw new Error(`coverartarchive image ${imgRes.status}`)
  const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg"
  const imageBytes = new Uint8Array(await imgRes.arrayBuffer())

  return {
    source: "coverartarchive",
    url: pick.image,
    imageBytes,
    mimeType,
    width: pick.width ?? null,
    height: pick.height ?? null,
    matchedScore: 1.0,
  }
}
