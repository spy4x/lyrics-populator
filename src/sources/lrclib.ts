// LRCLib API client. https://lrclib.net — free, no auth.
import { similarity } from "../normalize.ts"

export interface LrcResult {
  source: "lrclib"
  url: string
  plain: string
  synced: string | null
  matchedTitle: string
  matchedArtist: string
}

const BASE = "https://lrclib.net"

export async function lrclibGet(opts: {
  artist: string
  title: string
  durationSec?: number
}): Promise<LrcResult | null> {
  const params = new URLSearchParams()
  params.set("artist_name", opts.artist)
  params.set("track_name", opts.title)
  if (opts.durationSec && opts.durationSec > 0) {
    params.set("duration", String(Math.round(opts.durationSec)))
  }
  const url = `${BASE}/api/get?${params}`
  const res = await fetch(url, { headers: { "User-Agent": "lyrics-populator/0.1" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`lrclib get ${res.status}`)
  const data = await res.json()
  if (!data || data.instrumental) return null
  return pickLyrics(data, url)
}

export async function lrclibSearch(opts: {
  artist: string
  title: string
  minSimilarity?: number
}): Promise<LrcResult | null> {
  const q = `${opts.artist} ${opts.title}`.trim()
  if (!q) return null
  const url = `${BASE}/api/search?q=${encodeURIComponent(q)}`
  const res = await fetch(url, { headers: { "User-Agent": "lyrics-populator/0.1" } })
  if (!res.ok) throw new Error(`lrclib search ${res.status}`)
  const arr = (await res.json()) as Array<Record<string, unknown>>
  if (!Array.isArray(arr) || arr.length === 0) return null
  const min = opts.minSimilarity ?? 0.6

  // Rank by combined similarity to artist + title, prefer plainLyrics presence
  const ranked = arr
    .filter((d) => !d.instrumental)
    .map((d) => {
      const t = String(d.trackName ?? "")
      const a = String(d.artistName ?? "")
      const sim = (similarity(t, opts.title) + similarity(a, opts.artist)) / 2
      return { d, sim }
    })
    .filter((r) => r.sim >= min)
    .sort((a, b) => b.sim - a.sim)

  if (!ranked.length) return null
  return pickLyrics(ranked[0].d, url)
}

function pickLyrics(data: Record<string, unknown>, url: string): LrcResult | null {
  const plain = String(data.plainLyrics ?? "").trim()
  const synced = String(data.syncedLyrics ?? "").trim() || null
  if (!plain && !synced) return null
  return {
    source: "lrclib",
    url,
    plain: plain || synced!.replace(/\[\d{1,2}:\d{2}[.:]\d{2,3}\]/g, "").trim(),
    synced,
    matchedTitle: String(data.trackName ?? ""),
    matchedArtist: String(data.artistName ?? ""),
  }
}
