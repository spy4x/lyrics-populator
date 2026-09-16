// State DB: JSON file persisted alongside target, with file lock + atomic save.
import { dirname, join } from "@std/path"
import { encodeHex } from "@std/encoding/hex"

// Legacy lyrics-focused enum. Kept for backwards-compat with old state files.
// New code uses FieldStatus (string union).
export enum LyricsStatus {
  NoLyrics = 1,
  Preexisted = 2,
  Populated = 3,
  PopulateFailed = 4,
  SkippedNonAudio = 5,
  DryRunWouldPopulate = 6,
  UnsupportedFormat = 7,
  MissingMetadata = 8,
}

// Fields the script can populate from external sources.
export type FieldName =
  | "artist"
  | "title"
  | "album"
  | "albumArtist"
  | "date"
  | "trackNumber"
  | "discNumber"
  | "genre"
  | "composer"
  | "lyrics"
  | "coverArt"
  | "replayGain" // declared for forward-compat; not fetched in Phase 1

export type FieldStatus =
  | "not-fetched" // never tried
  | "fetch-miss" // tried, no result from any source
  | "fetched" // populated from a source
  | "manual" // user provided
  | "skipped" // format doesn't support this field
  | "preexisted" // already present in file, left alone
  | "fetch-failed" // error during fetch (network etc), retryable

export interface FieldState {
  status: FieldStatus
  source: string | null // "musicbrainz" | "lrclib" | "manual" | etc.
  url: string | null
  attempts: number
  lastError: string | null
  matchedScore: number | null // 0..1 fuzzy match confidence
  preview?: string // first 200 chars for text fields, dimensions for coverArt
}

export const ALL_FIELDS: readonly FieldName[] = [
  "artist",
  "title",
  "album",
  "albumArtist",
  "date",
  "trackNumber",
  "discNumber",
  "genre",
  "composer",
  "lyrics",
  "coverArt",
  "replayGain",
] as const

export function defaultFields(): Record<FieldName, FieldState> {
  const out = {} as Record<FieldName, FieldState>
  for (const f of ALL_FIELDS) {
    out[f] = {
      status: "not-fetched",
      source: null,
      url: null,
      attempts: 0,
      lastError: null,
      matchedScore: null,
    }
  }
  return out
}

export interface SourceAttempt {
  source: string
  at: string
  ok: boolean
  matchedTitle?: string
  matchedArtist?: string
  url?: string
  error?: string
}

// Legacy populatedFrom shape, kept on Entry for backwards compat.
export interface PopulatedFromLegacy {
  source: string
  url: string
  plain: string
  synced: boolean
}

// Tag values currently held in file (after last write). Read from music-metadata
// or vorbis scan + written into the file by the writer.
export interface TagValues {
  artist: string
  title: string
  album: string
  albumArtist: string
  date: string
  trackNumber: number | null
  discNumber: number | null
  genre: string
  composer: string
  lyricsPreview: string
}

export function defaultTagValues(): TagValues {
  return {
    artist: "",
    title: "",
    album: "",
    albumArtist: "",
    date: "",
    trackNumber: null,
    discNumber: null,
    genre: "",
    composer: "",
    lyricsPreview: "",
  }
}

export interface Entry {
  relpath: string
  absPath: string
  ext: string
  // Top-level fields kept for backwards compat with v1 state files. New code
  // prefers entry.tags.* + entry.fields.*.
  artist: string
  title: string
  album: string
  durationSec: number
  fileSizeBytes: number
  sha256: string
  status: LyricsStatus
  attempts: number
  lastAttemptAt: string | null
  lastError: string | null
  sourcesTried: SourceAttempt[]
  populatedFrom: PopulatedFromLegacy | null
  // New in v2.
  tags: TagValues
  fields: Record<FieldName, FieldState>
}

export interface StateFile {
  version: 2
  createdAt: string
  updatedAt: string
  targetPath: string
  totalSeen: number
  entries: Record<string, Entry>
}

const STATE_VERSION = 2 as const

export function statePathFor(folderAbs: string): string {
  return join(folderAbs, ".lyrics-populator-state.json")
}

export function lockPathFor(folderAbs: string): string {
  return join(folderAbs, ".lyrics-populator.lock")
}

export function logPathFor(folderAbs: string): string {
  return join(folderAbs, ".lyrics-populator.log.jsonl")
}

export function emptyState(targetPath: string): StateFile {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    targetPath,
    totalSeen: 0,
    entries: {},
  }
}

// Backwards-compat migration: read a v1 or v2 state file. v1 entries get
// populatedFrom migrated into fields.lyrics, and missing top-level fields
// get filled in with defaults.
export function loadState(folderAbs: string): StateFile {
  const path = statePathFor(folderAbs)
  let parsed: StateFile
  try {
    const text = Deno.readTextFileSync(path)
    parsed = JSON.parse(text) as StateFile
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return emptyState(folderAbs)
    throw e
  }

  // Version bump: v1 → v2 (add tags + fields, migrate populatedFrom).
  if ((parsed.version as unknown) === 1) {
    parsed.version = 2
    for (const k of Object.keys(parsed.entries)) {
      const e = parsed.entries[k]
      e.tags = {
        artist: e.artist ?? "",
        title: e.title ?? "",
        album: e.album ?? "",
        albumArtist: "",
        date: "",
        trackNumber: null,
        discNumber: null,
        genre: "",
        composer: "",
        lyricsPreview: e.populatedFrom?.plain ?? "",
      }
      e.fields = defaultFields()
      // Migrate populatedFrom → fields.lyrics. Even when populatedFrom is null
      // (e.g. PopulateFailed without ever getting a result), carry the
      // legacy status over to fields.lyrics so we don't lose retry state.
      const legacyStatus = ((): FieldStatus => {
        switch (e.status) {
          case LyricsStatus.Populated:
            return "fetched"
          case LyricsStatus.Preexisted:
            return "preexisted"
          case LyricsStatus.PopulateFailed:
            return "fetch-failed"
          case LyricsStatus.DryRunWouldPopulate:
            return "fetched"
          default:
            return "not-fetched"
        }
      })()
      if (e.populatedFrom) {
        e.fields.lyrics = {
          status: legacyStatus,
          source: e.populatedFrom.source,
          url: e.populatedFrom.url || null,
          attempts: e.attempts,
          lastError: e.lastError,
          matchedScore: null,
          preview: e.populatedFrom.plain.slice(0, 200),
        }
      } else {
        e.fields.lyrics = {
          ...defaultFields().lyrics,
          status: legacyStatus,
          attempts: e.attempts,
          lastError: e.lastError,
        }
      }
    }
  }

  // Defensive: ensure all v2 entries have tags + fields even if loaded from a
  // partially-written future-format file.
  for (const k of Object.keys(parsed.entries)) {
    const e = parsed.entries[k]
    if (!e.tags) e.tags = defaultTagValues()
    if (!e.fields) e.fields = defaultFields()
  }

  return parsed
}

// In-process mutex + file lock around a folder.
export class StateLock {
  private file: Deno.FsFile | null = null
  constructor(public readonly folderAbs: string) {}

  acquire(): void {
    Deno.mkdirSync(this.folderAbs, { recursive: true })
    this.file = Deno.openSync(lockPathFor(this.folderAbs), {
      create: true,
      write: true,
      read: false,
    })
    // Non-blocking exclusive flock via Deno 2 FsFile.tryLockSync (exclusive=true).
    // tryLockSync returns boolean; false = already locked by another process.
    const ok = this.file.tryLockSync(true)
    if (!ok) {
      try {
        this.file.close()
      } catch { /* intentional: best-effort cleanup */ }
      this.file = null
      throw new Error(`another instance is running for ${this.folderAbs}`)
    }
  }

  release(): void {
    if (!this.file) return
    try {
      this.file.unlockSync()
    } catch { /* intentional: best-effort cleanup */ }
    try {
      this.file.close()
    } catch { /* intentional: best-effort cleanup */ }
    this.file = null
  }
}

// Atomic JSONL log appender.
export class JsonlLogger {
  private file: Deno.FsFile | null = null
  constructor(public readonly folderAbs: string) {}

  private ensureOpen(): Deno.FsFile {
    if (this.file) return this.file
    Deno.mkdirSync(this.folderAbs, { recursive: true })
    this.file = Deno.openSync(logPathFor(this.folderAbs), {
      create: true,
      append: true,
      write: true,
      read: false,
    })
    return this.file
  }

  append(event: Record<string, unknown>): void {
    const f = this.ensureOpen()
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n"
    const enc = new TextEncoder().encode(line)
    f.writeSync(enc)
  }

  close(): void {
    if (!this.file) return
    try {
      this.file.close()
    } catch { /* intentional: best-effort cleanup */ }
    this.file = null
  }
}

// Throttled state saver: writes to .tmp then renames over original.
export class StateSaver {
  private dirty = false
  private lastFlush = 0
  private timer: number | null = null
  private readonly flushIntervalMs = 2000
  private readonly flushBatchSize = 25
  private batchCount = 0

  constructor(private state: StateFile, private readonly folderAbs: string) {}

  markDirty(): void {
    this.dirty = true
    this.batchCount++
    const now = Date.now()
    if (this.batchCount >= this.flushBatchSize || now - this.lastFlush > this.flushIntervalMs) {
      this.flush()
    } else if (this.timer === null) {
      this.timer = setTimeout(() => {
        this.timer = null
        if (this.dirty) this.flush()
      }, this.flushIntervalMs) as unknown as number
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty) return
    this.state.updatedAt = new Date().toISOString()
    Deno.mkdirSync(this.folderAbs, { recursive: true })
    const path = statePathFor(this.folderAbs)
    const tmp = `${path}.tmp.${Deno.pid}.${Date.now()}`
    const json = JSON.stringify(this.state, null, 2)
    Deno.writeTextFileSync(tmp, json)
    Deno.renameSync(tmp, path)
    this.dirty = false
    this.lastFlush = Date.now()
    this.batchCount = 0
  }
}

export async function sha256OfFile(path: string): Promise<string> {
  const data = await Deno.readFile(path)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return encodeHex(new Uint8Array(digest))
}

// Quick helper used by writer verify.
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest requires ArrayBuffer not SharedArrayBuffer-backed view.
  const buf = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buf).set(bytes)
  const digest = await crypto.subtle.digest("SHA-256", buf)
  return encodeHex(new Uint8Array(digest))
}

export function ensureDir(path: string): void {
  Deno.mkdirSync(path, { recursive: true })
}

export function parentDirOf(filePath: string): string {
  return dirname(filePath)
}
