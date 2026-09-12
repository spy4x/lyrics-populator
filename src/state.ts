// State DB: JSON file persisted alongside target, with file lock + atomic save.
import { dirname, join } from "@std/path"
import { encodeHex } from "@std/encoding/hex"

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

export interface SourceAttempt {
  source: "lrclib" | "ovh"
  at: string
  ok: boolean
  matchedTitle?: string
  matchedArtist?: string
  url?: string
  error?: string
}

export interface Entry {
  relpath: string
  absPath: string
  ext: string
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
  populatedFrom: {
    source: "lrclib" | "ovh" | "manual"
    url: string
    plain: string
    synced: boolean
  } | null
}

export interface StateFile {
  version: 1
  createdAt: string
  updatedAt: string
  targetPath: string
  totalSeen: number
  entries: Record<string, Entry>
}

const STATE_VERSION = 1 as const

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

export function loadState(folderAbs: string): StateFile {
  const path = statePathFor(folderAbs)
  try {
    const text = Deno.readTextFileSync(path)
    const parsed = JSON.parse(text) as StateFile
    if (parsed.version !== STATE_VERSION) {
      console.warn(
        `state: version mismatch (got ${parsed.version}, want ${STATE_VERSION}); starting fresh`,
      )
      return emptyState(folderAbs)
    }
    return parsed
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return emptyState(folderAbs)
    throw e
  }
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
