// MusicBrainz API client. https://musicbrainz.org — free, no auth required
// for low-volume use, but identifying User-Agent is mandatory per their TOS.
import { similarity } from "../normalize.ts"
import { RateLimiter } from "./rate-limiter.ts"

// Shared limiter across all MusicBrainz calls (search + lookup). 1 req/s.
const mbLimiter = new RateLimiter({ requestsPerSecond: 1 })

// User-Agent identifying this tool. MusicBrainz requires it; abusive UAs
// get banned. Update the version when publishing releases.
const USER_AGENT =
  "lyrics-populator/0.1 ( https://github.com/spy4x/lyrics-populator )"

const BASE = "https://musicbrainz.org/ws/2"

export interface MusicBrainzResult {
  source: "musicbrainz"
  url: string
  matchedTitle: string
  matchedArtist: string
  matchedScore: number
  recordingMbid: string | null
  fields: {
    artist?: string
    album?: string
    albumArtist?: string
    date?: string
    trackNumber?: number
    discNumber?: number
    genre?: string
    composer?: string
    releaseMbid?: string
  }
}

async function mbFetch(path: string): Promise<Response> {
  await mbLimiter.acquire()
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}fmt=json`
  return await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } })
}

interface RecordingSearchHit {
  id: string
  score: number
  title: string
  "artist-credit"?: Array<{ name: string; artist: { id: string; name: string } }>
  length?: number
  releases?: Array<{ id: string; title: string; "primary-type"?: string }>
}

export interface MusicBrainzSearchOpts {
  artist: string
  title: string
  durationSec?: number
  minScore?: number // 0..1, default 0.6
}

// Search recordings and pick the best match above the score threshold.
export async function musicbrainzSearchRecording(
  opts: MusicBrainzSearchOpts,
): Promise<MusicBrainzResult | null> {
  const q = `recording:"${opts.title}" AND artist:"${opts.artist}"`
  const path = `/recording/?query=${encodeURIComponent(q)}&limit=10`
  const res = await mbFetch(path)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`musicbrainz search ${res.status}`)
  const data = await res.json() as { recordings?: RecordingSearchHit[] }
  const hits = data.recordings ?? []
  if (!hits.length) return null

  const min = opts.minScore ?? 0.6
  const ranked = hits.map((h) => {
    const artistName = h["artist-credit"]?.[0]?.name ?? ""
    const titleSim = similarity(h.title, opts.title)
    const artistSim = similarity(artistName, opts.artist)
    let durSim = 1
    if (opts.durationSec && h.length) {
      const diff = Math.abs(opts.durationSec * 1000 - h.length) / 1000
      durSim = Math.max(0, 1 - diff / 10) // within 10s = full credit
    }
    const score = 0.4 * titleSim + 0.4 * artistSim + 0.2 * durSim
    return { h, score }
  })
    .filter((r) => r.score >= min)
    .sort((a, b) => b.score - a.score)

  if (!ranked.length) return null
  const top = ranked[0].h

  // Pull recording details to get release info (album, date, trackNumber).
  const details = await musicbrainzGetRecording(top.id)
  return buildResult(top, details, ranked[0].score)
}

interface RecordingDetails {
  id: string
  title: string
  "artist-credit"?: Array<{ name: string; joinphrase?: string }>
  releases?: Array<{
    id: string
    title: string
    status?: string
    "release-events"?: Array<{ date?: string }>
    "track-list"?: Array<Array<{ position?: number; number?: string }>>
    "artist-credit"?: Array<{ name: string }>
    "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] }
  }>
  tags?: Array<{ name: string; count: number }>
  relations?: Array<{
    type?: string
    artist?: { id: string; name: string; "sort-name"?: string }
    "target-type"?: string
  }>
}

async function musicbrainzGetRecording(mbid: string): Promise<RecordingDetails | null> {
  const path = `/recording/${mbid}?inc=artist-credits+releases+release-rels+tags`
  const res = await mbFetch(path)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`musicbrainz recording ${res.status}`)
  return await res.json() as RecordingDetails
}

function buildResult(
  hit: RecordingSearchHit,
  details: RecordingDetails | null,
  score: number,
): MusicBrainzResult {
  const artistName = hit["artist-credit"]?.[0]?.name ?? ""
  const url = `https://musicbrainz.org/recording/${hit.id}`
  const fields: MusicBrainzResult["fields"] = { artist: artistName }

  if (!details) {
    return {
      source: "musicbrainz",
      url,
      matchedTitle: hit.title,
      matchedArtist: artistName,
      matchedScore: score,
      recordingMbid: hit.id,
      fields,
    }
  }

  // Pick best release: prefer "Album" primary type, earliest date.
  type Release = NonNullable<RecordingDetails["releases"]>[number]
  const releases = (details.releases ?? []).filter((r) => r.status !== "Pseudo-Release")
  let bestRelease: Release | null = null
  let bestScore = -1
  for (const r of releases) {
    let s = 0
    if (r["release-group"]?.["primary-type"] === "Album") s += 2
    if (r["release-group"]?.["primary-type"] === "Single") s += 1
    if (r["release-events"]?.[0]?.date) s += 1
    if (s > bestScore) {
      bestScore = s
      bestRelease = r
    }
  }
  if (!bestRelease && releases.length) bestRelease = releases[0]

  if (bestRelease) {
    fields.album = bestRelease.title
    fields.releaseMbid = bestRelease.id
    fields.albumArtist = bestRelease["artist-credit"]?.[0]?.name
    const date = bestRelease["release-events"]?.[0]?.date
    if (date) fields.date = date
    const trackEntry = bestRelease["track-list"]?.[0]?.[0]
    if (trackEntry) {
      if (typeof trackEntry.position === "number") fields.trackNumber = trackEntry.position
      else if (trackEntry.number) {
        const n = parseInt(trackEntry.number, 10)
        if (!isNaN(n)) fields.trackNumber = n
      }
    }
  }

  // Tags → genre. MusicBrainz returns tags sorted by community vote count.
  const topTag = (details.tags ?? [])[0]
  if (topTag) fields.genre = topTag.name

  // Composer relation.
  const composer = (details.relations ?? []).find((r) =>
    r.type === "composer" && r["target-type"] === "artist"
  )
  if (composer?.artist) fields.composer = composer.artist.name

  return {
    source: "musicbrainz",
    url,
    matchedTitle: hit.title,
    matchedArtist: artistName,
    matchedScore: score,
    recordingMbid: hit.id,
    fields,
  }
}
