// Main entry point. Reads CLI args, scans, fetches, writes.
import { parseArgs } from "@std/cli"
import { resolveTarget, scanFolder, type ScannedFile } from "../src/scanner.ts"
import {
  defaultFields,
  defaultTagValues,
  type Entry,
  type FieldName,
  type FieldState,
  JsonlLogger,
  loadState,
  LyricsStatus,
  parentDirOf,
  sha256OfFile,
  StateFile,
  StateLock,
  StateSaver,
  type TagValues,
} from "../src/state.ts"
import { normalize } from "../src/normalize.ts"
import { fetchLyrics } from "../src/sources/index.ts"
import { musicbrainzSearchRecording } from "../src/sources/musicbrainz.ts"
import { coverartarchiveGetFront } from "../src/sources/coverartarchive.ts"
import { readTags, toTagValues, writeMetadata } from "../src/metadata.ts"

interface CliArgs {
  _: (string | number)[]
  source: string
  concurrency: number
  "delay-ms": number
  "dry-run": boolean
  "force-overwrite-lyrics": boolean
  "max-attempts": number
  limit: number
  "keep-synced": boolean
  "manual-lyrics": string
  fields: string
  "mb-confidence": number
  "no-cover-art": boolean
  verbose: boolean
  help: boolean
}

const args = parseArgs(Deno.args, {
  string: ["source", "manual-lyrics", "fields"],
  boolean: [
    "dry-run",
    "force-overwrite-lyrics",
    "keep-synced",
    "no-cover-art",
    "verbose",
    "help",
  ],
  default: {
    source: "both",
    concurrency: 4,
    "delay-ms": 250,
    "dry-run": false,
    "force-overwrite-lyrics": false,
    "keep-synced": false,
    "max-attempts": 3,
    limit: 0,
    "manual-lyrics": "",
    fields: "lyrics",
    "mb-confidence": 0.8,
    "no-cover-art": false,
    verbose: false,
    help: false,
  },
}) as unknown as CliArgs

if (args.help || args._.length === 0) {
  console.log(`lyrics-populator

Usage:
  deno task populate <folder-or-file> [flags]

Flags:
  --source <lrclib|ovh|both>      Lyrics source (default both)
  --fields <list>                 Comma-separated fields to populate
                                   (default: lyrics). Example: lyrics,artist,album,date,coverArt
                                   Available: artist,title,album,albumArtist,date,
                                              trackNumber,discNumber,genre,composer,
                                              lyrics,coverArt
  --concurrency <N>                Parallel workers (default 4)
  --delay-ms <N>                   Base delay between requests with ±50% jitter (default 250)
  --mb-confidence <n>              MusicBrainz match score threshold 0..1 (default 0.8)
  --no-cover-art                   Skip cover art fetching (shorthand for excluding coverArt)
  --dry-run                        Do not write tags or persist populated state
  --force-overwrite-lyrics         Overwrite preexisting lyrics
  --keep-synced                    Store LRC timestamps in LYRICS (default: plain text only)
  --max-attempts <N>               Attempts before PopulateFailed (default 3)
  --limit <N>                      Process at most N files
  --manual-lyrics <dir>            Use <dir>/<relpath>.txt as lyrics override (bypasses fetch)
  --verbose                        Per-file terminal output

State: .lyrics-populator-state.json
Log:   .lyrics-populator.log.jsonl
`)
  Deno.exit(args.help ? 0 : 1)
}

const inputPath = String(args._[0])
const target = resolveTarget(inputPath)
const stateRoot = target.kind === "folder" ? target.absPath : parentDirOf(target.absPath)

const enabledFields = new Set<FieldName>(
  args.fields.split(",").map((f) => f.trim()).filter(Boolean) as FieldName[],
)
if (args["no-cover-art"]) enabledFields.delete("coverArt")
const doLyrics = enabledFields.has("lyrics")
const doCoverArt = enabledFields.has("coverArt")
const doMetadata = [...enabledFields].some((f) => f !== "lyrics" && f !== "coverArt")

const lock = new StateLock(stateRoot)
lock.acquire()

const cleanup = () => {
  try {
    saver.flush()
  } catch { /* intentional: best-effort cleanup */ }
  log.close()
  lock.release()
  Deno.exit(130)
}
Deno.addSignalListener("SIGINT", cleanup)
Deno.addSignalListener("SIGTERM", cleanup)

const state: StateFile = loadState(stateRoot)
const saver = new StateSaver(state, stateRoot)
const log = new JsonlLogger(stateRoot)

const counters = {
  total: 0,
  populated: 0,
  preexisting: 0,
  failed: 0,
  skipped: 0,
  inFlight: 0,
}

function renderProgress(): string {
  const now = new Date().toISOString().slice(11, 19)
  return `[${now}] scanned ${counters.total} | populated ${counters.populated} | preexisting ${counters.preexisting} | failed ${counters.failed} | skipped ${counters.skipped} | in-flight ${counters.inFlight}`
}

let lastProgress = 0
setInterval(() => {
  const now = Date.now()
  if (now - lastProgress < 2000) return
  lastProgress = now
  Deno.stdout.writeSync(new TextEncoder().encode("\r" + renderProgress() + " ".repeat(20)))
}, 1000)

const worklist: ScannedFile[] = []
if (target.kind === "file") {
  const stat = Deno.statSync(target.absPath)
  worklist.push({
    absPath: target.absPath,
    relpath: target.relpath,
    ext: target.absPath.split(".").pop()!.toLowerCase() as ScannedFile["ext"],
    sizeBytes: stat.size,
  })
} else {
  for await (const f of scanFolder(target.absPath)) {
    worklist.push(f)
    if (args.limit > 0 && worklist.length >= args.limit) break
  }
}
counters.total = worklist.length
state.totalSeen = Math.max(state.totalSeen, counters.total)
saver.markDirty()

if (args.verbose) console.log(`scan: ${worklist.length} files in ${target.absPath}`)

const queue = [...worklist]
async function worker(): Promise<void> {
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    counters.inFlight++
    try {
      await processFile(item)
    } catch (e) {
      console.error(`fatal: ${item.relpath}: ${(e as Error).message}`)
    } finally {
      counters.inFlight--
    }
  }
}

async function processFile(file: ScannedFile): Promise<void> {
  const existing = state.entries[file.relpath]
  const sha = await sha256OfFile(file.absPath)

  // Skip already-completed (per legacy LyricsStatus checks; field-level
  // check below).
  if (existing && existing.sha256 === sha && !args["force-overwrite-lyrics"]) {
    if (existing.status === LyricsStatus.Populated || existing.status === LyricsStatus.Preexisted) {
      counters.skipped++
      log.append({ event: "skip", relpath: file.relpath, reason: existing.status })
      return
    }
    if (existing.status === LyricsStatus.UnsupportedFormat) {
      counters.skipped++
      log.append({ event: "skip", relpath: file.relpath, reason: "unsupported" })
      return
    }
    if (
      existing.status === LyricsStatus.PopulateFailed &&
      existing.attempts >= args["max-attempts"]
    ) {
      counters.skipped++
      log.append({ event: "skip", relpath: file.relpath, reason: "max-attempts-reached" })
      return
    }
  }

  // Read tags
  let meta
  try {
    meta = await readTags(file.absPath)
  } catch (e) {
    updateEntry(file, sha, defaultTagValues(), {
      status: LyricsStatus.PopulateFailed,
      lastError: `meta read failed: ${(e as Error).message}`,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    })
    counters.failed++
    log.append({ event: "read-fail", relpath: file.relpath, error: (e as Error).message })
    return
  }

  // Missing metadata — at minimum we need a title to search MusicBrainz/LRCLib.
  if (!meta.title.trim()) {
    updateEntry(file, sha, toTagValues(meta), {
      status: LyricsStatus.MissingMetadata,
      lastError: "no title tag",
    })
    counters.skipped++
    log.append({ event: "skip", relpath: file.relpath, reason: "no-title" })
    return
  }

  // Format check
  if (
    file.ext !== "mp3" && file.ext !== "opus" && file.ext !== "flac" && file.ext !== "ogg"
  ) {
    updateEntry(file, sha, toTagValues(meta), {
      status: LyricsStatus.UnsupportedFormat,
      lastError: `ext ${file.ext} not writable`,
    })
    counters.skipped++
    log.append({ event: "skip", relpath: file.relpath, reason: "unsupported-ext" })
    return
  }

  const tagVals = toTagValues(meta)

  // If lyrics are missing and we're not running lyrics-only, fetch metadata
  // first (need it to get releaseMbid for cover art). Otherwise start with lyrics.
  let lyricsResult: { plain: string; synced: string | null; source: string; url: string } | null =
    null
  let mbResult: Awaited<ReturnType<typeof musicbrainzSearchRecording>> = null
  let coverResult: Awaited<ReturnType<typeof coverartarchiveGetFront>> = null

  const norm = normalize(meta.artist, meta.title)
  if (!norm.artist) norm.artist = meta.artist.trim()
  if (!norm.title) norm.title = meta.title.trim()

  // 1) Manual lyrics override
  let manualLyrics: string | null = null
  if (doLyrics && args["manual-lyrics"]) {
    const manualPath = `${args["manual-lyrics"]}/${file.relpath}.txt`
    try {
      manualLyrics = await Deno.readTextFile(manualPath)
    } catch {
      // no manual override
    }
  }

  // 2) Fetch lyrics (existing chain)
  if (doLyrics && !meta.hasLyrics && !args["force-overwrite-lyrics"]) {
    // Already has lyrics — skip fetch
  } else if (doLyrics && manualLyrics === null) {
    lyricsResult = await fetchLyricsForFile(norm.artist, norm.title, meta.durationSec)
  }

  // 3) Fetch MusicBrainz metadata (Phase 1 fields only: artist/title/album/date/trackNumber/discNumber/genre/composer)
  if (
    doMetadata &&
    (file.ext === "mp3" || file.ext === "opus" || file.ext === "flac" || file.ext === "ogg")
  ) {
    mbResult = await musicbrainzSearchRecording({
      artist: norm.artist,
      title: norm.title,
      durationSec: meta.durationSec,
      minScore: args["mb-confidence"],
    })
  }

  // 4) Fetch cover art from MusicBrainz release-id
  if (doCoverArt && mbResult?.fields.releaseMbid) {
    coverResult = await coverartarchiveGetFront(mbResult.fields.releaseMbid)
  }

  // Build write payload from what we got
  const writePayload: Parameters<typeof writeMetadata>[1] = { source: "musicbrainz" }

  // Apply metadata fields
  if (mbResult) {
    const f = mbResult.fields
    if (f.artist !== undefined) writePayload.artist = f.artist
    if (f.album !== undefined) writePayload.album = f.album
    if (f.albumArtist !== undefined) writePayload.albumArtist = f.albumArtist
    if (f.date !== undefined) writePayload.date = f.date
    if (f.trackNumber !== undefined) writePayload.trackNumber = f.trackNumber
    if (f.discNumber !== undefined) writePayload.discNumber = f.discNumber
    if (f.genre !== undefined) writePayload.genre = f.genre
    if (f.composer !== undefined) writePayload.composer = f.composer
  }

  // Apply lyrics
  if (manualLyrics !== null) {
    writePayload.lyrics = { plain: manualLyrics }
    writePayload.source = "manual"
  } else if (lyricsResult) {
    writePayload.lyrics = {
      plain: lyricsResult.plain,
      synced: args["keep-synced"] ? lyricsResult.synced ?? undefined : undefined,
    }
    writePayload.source = lyricsResult.source
  }

  // Apply cover art
  if (coverResult) {
    writePayload.coverArt = { bytes: coverResult.imageBytes, mimeType: coverResult.mimeType }
  }

  // If nothing to write, treat as preexisting (all enabled fields already populated)
  const hasNothingToWrite = writePayload.artist === undefined &&
    writePayload.album === undefined &&
    writePayload.title === undefined &&
    writePayload.albumArtist === undefined &&
    writePayload.date === undefined &&
    writePayload.trackNumber === undefined &&
    writePayload.discNumber === undefined &&
    writePayload.genre === undefined &&
    writePayload.composer === undefined &&
    writePayload.lyrics === undefined &&
    writePayload.coverArt === undefined

  if (hasNothingToWrite) {
    updateEntry(file, sha, tagVals, {
      status: LyricsStatus.Preexisted,
    })
    counters.preexisting++
    log.append({ event: "skip", relpath: file.relpath, reason: "preexisted" })
    return
  }

  if (args["dry-run"]) {
    const newFields = buildFieldsFromPayload(
      existing?.fields ?? defaultFields(),
      writePayload,
      mbResult,
      coverResult,
      lyricsResult,
      manualLyrics !== null,
    )
    updateEntry(file, sha, tagVals, {
      status: LyricsStatus.DryRunWouldPopulate,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      fields: newFields,
      populatedFrom: lyricsResult
        ? {
          source: lyricsResult.source as "lrclib" | "ovh" | "manual",
          url: lyricsResult.url,
          plain: lyricsResult.plain.slice(0, 200),
          synced: !!lyricsResult.synced,
        }
        : manualLyrics !== null
        ? { source: "manual", url: "", plain: manualLyrics.slice(0, 200), synced: false }
        : existing?.populatedFrom ?? null,
    })
    counters.populated++
    log.append({
      event: "dry-run-ok",
      relpath: file.relpath,
      source: writePayload.source,
    })
    return
  }

  const writeRes = await writeMetadata(file.absPath, writePayload)
  if (!writeRes.ok) {
    const newAttempts = (existing?.attempts ?? 0) + 1
    const failed = newAttempts >= args["max-attempts"]
    updateEntry(file, sha, tagVals, {
      status: failed ? LyricsStatus.PopulateFailed : LyricsStatus.NoLyrics,
      attempts: newAttempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: writeRes.error ?? "write failed",
    })
    counters.failed++
    log.append({ event: "write-fail", relpath: file.relpath, error: writeRes.error })
    return
  }

  // Update each field in the field matrix based on what we wrote.
  const newFields = buildFieldsFromPayload(
    existing?.fields ?? defaultFields(),
    writePayload,
    mbResult,
    coverResult,
    lyricsResult,
    manualLyrics !== null,
  )
  updateEntry(file, sha, tagVals, {
    status: LyricsStatus.Populated,
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    fields: newFields,
    populatedFrom: lyricsResult
      ? {
        source: lyricsResult.source as "lrclib" | "ovh" | "manual",
        url: lyricsResult.url,
        plain: lyricsResult.plain.slice(0, 200),
        synced: !!lyricsResult.synced,
      }
      : manualLyrics !== null
      ? { source: "manual", url: "", plain: manualLyrics.slice(0, 200), synced: false }
      : existing?.populatedFrom ?? null,
  })
  counters.populated++
  log.append({
    event: "write-ok",
    relpath: file.relpath,
    source: writePayload.source,
    size: writeRes.newSize,
  })
}

function buildFieldsFromPayload(
  base: Record<FieldName, FieldState>,
  payload: Parameters<typeof writeMetadata>[1],
  mbResult: Awaited<ReturnType<typeof musicbrainzSearchRecording>>,
  coverResult: Awaited<ReturnType<typeof coverartarchiveGetFront>>,
  lyricsResult: { source: string; url: string; plain: string; synced: string | null } | null,
  isManual: boolean,
): Record<FieldName, FieldState> {
  const out = { ...base }
  const src = payload.source

  // Metadata fields from MusicBrainz
  if (mbResult) {
    const f = mbResult.fields
    const score = mbResult.matchedScore
    for (
      const field of [
        "artist",
        "album",
        "albumArtist",
        "date",
        "trackNumber",
        "discNumber",
        "genre",
        "composer",
      ] as const
    ) {
      if (f[field] !== undefined) {
        out[field] = {
          status: "fetched",
          source: "musicbrainz",
          url: mbResult.url,
          attempts: 1,
          lastError: null,
          matchedScore: score,
          preview: String(f[field]).slice(0, 200),
        }
      }
    }
  }

  // Cover art
  if (coverResult) {
    out.coverArt = {
      status: "fetched",
      source: "coverartarchive",
      url: coverResult.url,
      attempts: 1,
      lastError: null,
      matchedScore: coverResult.matchedScore,
      preview: `${coverResult.width}x${coverResult.height} ${coverResult.mimeType}`,
    }
  }

  // Lyrics
  if (payload.lyrics) {
    out.lyrics = {
      status: isManual ? "manual" : "fetched",
      source: isManual ? "manual" : (lyricsResult?.source ?? src),
      url: lyricsResult?.url ?? "",
      attempts: 1,
      lastError: null,
      matchedScore: lyricsResult ? null : null,
      preview: payload.lyrics.plain.slice(0, 200),
    }
  }

  return out
}

async function fetchLyricsForFile(
  artist: string,
  title: string,
  durationSec: number,
): Promise<{ plain: string; synced: string | null; source: string; url: string } | null> {
  const trySources = args.source === "both"
    ? ["lrclib", "ovh"] as const
    : [args.source as "lrclib" | "ovh"]
  for (const source of trySources) {
    try {
      const r = await fetchLyrics({ source, artist, title, durationSec })
      if (r) {
        return {
          plain: r.plain,
          synced: r.synced,
          source: r.source,
          url: r.url,
        }
      }
    } catch {
      // continue to next source
    }
    await jitter(args["delay-ms"])
  }
  return null
}

function updateEntry(
  file: ScannedFile,
  sha: string,
  tagVals: TagValues,
  patch: Partial<Entry>,
): void {
  const cur = state.entries[file.relpath] ?? {
    relpath: file.relpath,
    absPath: file.absPath,
    ext: file.ext,
    artist: tagVals.artist,
    title: tagVals.title,
    album: tagVals.album,
    durationSec: 0,
    fileSizeBytes: file.sizeBytes,
    sha256: "",
    status: LyricsStatus.NoLyrics,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    sourcesTried: [],
    populatedFrom: null,
    tags: tagVals,
    fields: defaultFields(),
  }
  const next: Entry = {
    ...cur,
    ...patch,
    sha256: sha,
    fileSizeBytes: file.sizeBytes,
    tags: patch.tags ?? cur.tags ?? tagVals,
    fields: patch.fields ?? cur.fields ?? defaultFields(),
  }
  state.entries[file.relpath] = next
  saver.markDirty()
}

function jitter(base: number): Promise<void> {
  const delta = base * 0.5
  const ms = base + (Math.random() * 2 - 1) * delta
  return new Promise((r) => setTimeout(r, Math.max(50, ms)))
}

const workers: Promise<void>[] = []
for (let i = 0; i < args.concurrency; i++) workers.push(worker())
await Promise.all(workers)

saver.flush()
log.close()
lock.release()

console.log("\n" + renderProgress())
console.log(`\nstate: ${stateRoot}/.lyrics-populator-state.json`)
console.log(`log:   ${stateRoot}/.lyrics-populator.log.jsonl`)
const failed = Object.values(state.entries).filter((e) => e.status === LyricsStatus.PopulateFailed)
  .length
Deno.exit(failed > 0 ? 1 : 0)
