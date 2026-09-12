// Source registry + fallback logic.
import { lrclibGet, lrclibSearch, type LrcResult } from "./lrclib.ts"
import { ovhGet, type OvhResult } from "./ovh.ts"

export type SourceResult = LrcResult | OvhResult

export type SourceName = "lrclib" | "ovh"

export interface FetchOpts {
  source: "lrclib" | "ovh" | "both"
  artist: string
  title: string
  durationSec?: number
}

export async function fetchLyrics(opts: FetchOpts): Promise<SourceResult | null> {
  const chain: SourceName[] = opts.source === "both" ? ["lrclib", "ovh"] : [opts.source]

  for (const name of chain) {
    try {
      const r = await fetchOne(name, opts)
      if (r) return r
    } catch (e) {
      // Surface error via throwing up; orchestrator records per-source attempt.
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
  } else {
    return await ovhGet({ artist: opts.artist, title: opts.title })
  }
}
