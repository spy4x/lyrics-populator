// Source registry + fallback logic. New field × source matrix orchestrator.
// Old per-source fetchLyrics (lyrics-only) kept as thin wrapper for backwards
// compatibility with callers that haven't migrated yet.

import { lrclibGet, lrclibSearch, type LrcResult } from "./lrclib.ts"
import { ovhGet, type OvhResult } from "./ovh.ts"
import { type MusicBrainzResult, musicbrainzSearchRecording } from "./musicbrainz.ts"
import type { CoverArtResult } from "./coverartarchive.ts"

export type SourceName = "lrclib" | "ovh" | "musicbrainz" | "coverartarchive" | "manual"

export type SourceResult = LrcResult | OvhResult | MusicBrainzResult | CoverArtResult

export interface FetchOpts {
  source: SourceName | "both" // "both" = lrclib → ovh for lyrics
  artist: string
  title: string
  durationSec?: number
  minScore?: number
}

// Legacy wrapper for lyrics-only fetching. Used by scripts that haven't
// migrated to the per-field orchestrator yet (or by tests).
export async function fetchLyrics(opts: FetchOpts): Promise<SourceResult | null> {
  const chain: SourceName[] = opts.source === "both"
    ? ["lrclib", "ovh"]
    : [opts.source as SourceName]
  for (const name of chain) {
    try {
      const r = await fetchOne(name, opts)
      if (r) return r
    } catch (e) {
      throw e
    }
  }
  return null
}

async function fetchOne(name: SourceName, opts: FetchOpts): Promise<SourceResult | null> {
  if (name === "lrclib") {
    const exact = await lrclibGet({
      artist: opts.artist,
      title: opts.title,
      durationSec: opts.durationSec,
    })
    if (exact) return exact
    return await lrclibSearch({ artist: opts.artist, title: opts.title })
  }
  if (name === "ovh") {
    return await ovhGet({ artist: opts.artist, title: opts.title })
  }
  if (name === "musicbrainz") {
    return await musicbrainzSearchRecording({
      artist: opts.artist,
      title: opts.title,
      durationSec: opts.durationSec,
      minScore: opts.minScore,
    })
  }
  return null // coverartarchive needs a releaseMbid, fetched separately
}
