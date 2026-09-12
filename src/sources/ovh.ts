// lyrics.ovh API client. https://api.lyrics.ovh — free, no auth.
export interface OvhResult {
  source: "ovh"
  url: string
  plain: string
  synced: null
  matchedTitle: string
  matchedArtist: string
}

const BASE = "https://api.lyrics.ovh/v1"

export async function ovhGet(opts: { artist: string; title: string }): Promise<OvhResult | null> {
  const a = encodeURIComponent(opts.artist.trim())
  const t = encodeURIComponent(opts.title.trim())
  if (!a || !t) return null
  const url = `${BASE}/${a}/${t}`
  const res = await fetch(url, { headers: { "User-Agent": "lyrics-populator/0.1" } })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`ovh ${res.status}`)
  const data = await res.json() as { lyrics?: string; error?: string }
  const text = (data.lyrics ?? "").trim()
  if (!text) return null
  return {
    source: "ovh",
    url,
    plain: text,
    synced: null,
    matchedTitle: opts.title,
    matchedArtist: opts.artist,
  }
}
