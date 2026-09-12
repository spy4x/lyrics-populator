// Main entry point. Reads CLI args, scans, fetches, writes.
import { parseArgs } from "@std/cli"
import { resolveTarget, scanFolder, type ScannedFile } from "../src/scanner.ts"
import {
  type Entry,
  JsonlLogger,
  loadState,
  LyricsStatus,
  parentDirOf,
  sha256OfFile,
  type SourceAttempt,
  StateFile,
  StateLock,
  StateSaver,
} from "../src/state.ts"
import { normalize } from "../src/normalize.ts"
import { fetchLyrics } from "../src/sources/index.ts"
import { readMeta, writeLyrics } from "../src/metadata.ts"

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
  verbose: boolean
  help: boolean
}

const args = parseArgs(Deno.args, {
  string: ["source", "manual-lyrics"],
  boolean: ["dry-run", "force-overwrite-lyrics", "keep-synced", "verbose", "help"],
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
  --concurrency <N>                Parallel workers (default 4)
  --delay-ms <N>                   Base delay between requests with ±50% jitter (default 250)
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
// State lives in parent dir of file, or root folder itself
const stateRoot = target.kind === "folder" ? target.absPath : parentDirOf(target.absPath)

// Acquire lock (single-instance guarantee)
const lock = new StateLock(stateRoot)
lock.acquire()

// Graceful shutdown: flush state on SIGINT
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

// Progress tracking
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

// Build worklist
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

// Concurrency pool
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
  // Skip already-completed unless forced + dirty (different sha)
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
    meta = await readMeta(file.absPath)
  } catch (e) {
    updateEntry(file, sha, {
      status: LyricsStatus.PopulateFailed,
      lastError: `meta read failed: ${(e as Error).message}`,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
    })
    counters.failed++
    log.append({ event: "read-fail", relpath: file.relpath, error: (e as Error).message })
    return
  }

  // Missing metadata
  if (!meta.title.trim()) {
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: LyricsStatus.MissingMetadata,
      lastError: "no title tag",
    })
    counters.skipped++
    log.append({ event: "skip", relpath: file.relpath, reason: "no-title" })
    return
  }

  // Preexisting lyrics
  if (meta.hasLyrics && !args["force-overwrite-lyrics"]) {
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: LyricsStatus.Preexisted,
    })
    counters.preexisting++
    log.append({ event: "skip", relpath: file.relpath, reason: "preexisted" })
    return
  }

  // Unsure format support
  if (file.ext !== "mp3" && file.ext !== "opus" && file.ext !== "flac" && file.ext !== "ogg") {
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: LyricsStatus.UnsupportedFormat,
      lastError: `ext ${file.ext} not writable`,
    })
    counters.skipped++
    log.append({ event: "skip", relpath: file.relpath, reason: "unsupported-ext" })
    return
  }

  // Manual lyrics override: if a file at <manual-dir>/<relpath>.txt exists,
  // use its content as the lyrics (bypassing fetch).
  let manualLyrics: string | null = null
  if (args["manual-lyrics"]) {
    const manualPath = `${args["manual-lyrics"]}/${file.relpath}.txt`
    try {
      manualLyrics = await Deno.readTextFile(manualPath)
    } catch {
      // no manual override; fall through to fetch
    }
  }

  // Fetch lyrics
  const norm = normalize(meta.artist, meta.title)
  if (!norm.artist) norm.artist = meta.artist.trim()
  if (!norm.title) norm.title = meta.title.trim()

  // If manual lyrics provided, write directly.
  if (manualLyrics !== null) {
    if (args["dry-run"]) {
      updateEntry(file, sha, {
        artist: meta.artist,
        title: meta.title,
        album: meta.album,
        durationSec: meta.durationSec,
        status: LyricsStatus.DryRunWouldPopulate,
        attempts: (existing?.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        populatedFrom: { source: "manual" as const, url: "", plain: manualLyrics.slice(0, 200), synced: false },
      })
      counters.populated++
      log.append({ event: "dry-run-manual", relpath: file.relpath })
      return
    }
    const writeRes = await writeLyrics(file.absPath, {
      plain: manualLyrics,
      source: "manual",
    })
    if (writeRes.ok) {
      updateEntry(file, sha, {
        artist: meta.artist,
        title: meta.title,
        album: meta.album,
        durationSec: meta.durationSec,
        status: LyricsStatus.Populated,
        attempts: (existing?.attempts ?? 0) + 1,
        lastAttemptAt: new Date().toISOString(),
        populatedFrom: { source: "manual" as const, url: "", plain: manualLyrics.slice(0, 200), synced: false },
      })
      counters.populated++
      log.append({ event: "manual-ok", relpath: file.relpath, size: writeRes.newSize })
      return
    }
    log.append({ event: "manual-fail", relpath: file.relpath, error: writeRes.error })
    // fall through to fetch on failure
  }

  const trySources: ("lrclib" | "ovh")[] = args.source === "both"
    ? ["lrclib", "ovh"]
    : [args.source as "lrclib" | "ovh"]

  let result = null
  const attempts: SourceAttempt[] = []
  for (const source of trySources) {
    const at = new Date().toISOString()
    try {
      const r = await fetchLyrics({
        source,
        artist: norm.artist,
        title: norm.title,
        durationSec: meta.durationSec,
      })
      if (r) {
        attempts.push({
          source,
          at,
          ok: true,
          matchedTitle: r.matchedTitle,
          matchedArtist: r.matchedArtist,
          url: r.url,
        })
        result = r
        break
      } else {
        attempts.push({ source, at, ok: false, error: "no result" })
      }
    } catch (e) {
      attempts.push({ source, at, ok: false, error: (e as Error).message })
    }
    // jitter delay before next source attempt
    await jitter(args["delay-ms"])
  }

  if (!result) {
    const newAttempts = (existing?.attempts ?? 0) + 1
    const failed = newAttempts >= args["max-attempts"]
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: failed ? LyricsStatus.PopulateFailed : LyricsStatus.NoLyrics,
      attempts: newAttempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: attempts[attempts.length - 1]?.error ?? "no result",
      sourcesTried: [...(existing?.sourcesTried ?? []), ...attempts].slice(-20),
    })
    if (failed) {
      counters.failed++
      log.append({ event: "fetch-fail", relpath: file.relpath, attempts: newAttempts })
    } else {
      counters.skipped++
      log.append({ event: "fetch-miss", relpath: file.relpath, attempts: newAttempts })
    }
    return
  }

  // Write (or dry-run)
  if (args["dry-run"]) {
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: LyricsStatus.DryRunWouldPopulate,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date().toISOString(),
      sourcesTried: [...(existing?.sourcesTried ?? []), ...attempts].slice(-20),
      populatedFrom: {
        source: result.source,
        url: result.url,
        plain: result.plain.slice(0, 200),
        synced: !!result.synced,
      },
    })
    counters.populated++
    log.append({
      event: "dry-run-ok",
      relpath: file.relpath,
      source: result.source,
      url: result.url,
    })
    return
  }

  // Strip LRC timestamps unless user explicitly opts in.
  // Synced is only used by node-id3 for MP3 SYLT frame (when writing MP3).
  const plainText = result.plain
  const syncedForMp3 = args["keep-synced"] ? result.synced ?? undefined : undefined

  const writeRes = await writeLyrics(file.absPath, {
    plain: plainText,
    synced: syncedForMp3,
    source: result.source,
  })

  if (!writeRes.ok) {
    const newAttempts = (existing?.attempts ?? 0) + 1
    const failed = newAttempts >= args["max-attempts"]
    updateEntry(file, sha, {
      artist: meta.artist,
      title: meta.title,
      album: meta.album,
      durationSec: meta.durationSec,
      status: failed ? LyricsStatus.PopulateFailed : LyricsStatus.NoLyrics,
      attempts: newAttempts,
      lastAttemptAt: new Date().toISOString(),
      lastError: writeRes.error ?? "write failed",
      sourcesTried: [...(existing?.sourcesTried ?? []), ...attempts].slice(-20),
    })
    counters.failed++
    log.append({ event: "write-fail", relpath: file.relpath, error: writeRes.error })
    return
  }

  updateEntry(file, sha, {
    artist: meta.artist,
    title: meta.title,
    album: meta.album,
    durationSec: meta.durationSec,
    status: LyricsStatus.Populated,
    attempts: (existing?.attempts ?? 0) + 1,
    lastAttemptAt: new Date().toISOString(),
    sourcesTried: [...(existing?.sourcesTried ?? []), ...attempts].slice(-20),
    populatedFrom: {
      source: result.source,
      url: result.url,
      plain: result.plain.slice(0, 200),
      synced: !!result.synced,
    },
  })
  counters.populated++
  log.append({
    event: "write-ok",
    relpath: file.relpath,
    source: result.source,
    url: result.url,
    size: writeRes.newSize,
  })
}

function updateEntry(file: ScannedFile, sha: string, patch: Partial<Entry>): void {
  const cur = state.entries[file.relpath] ?? {
    relpath: file.relpath,
    absPath: file.absPath,
    ext: file.ext,
    artist: "",
    title: "",
    album: "",
    durationSec: 0,
    fileSizeBytes: file.sizeBytes,
    sha256: "",
    status: LyricsStatus.NoLyrics,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    sourcesTried: [],
    populatedFrom: null,
  }
  const next: Entry = {
    ...cur,
    ...patch,
    sha256: sha,
    fileSizeBytes: file.sizeBytes,
  }
  state.entries[file.relpath] = next
  saver.markDirty()
}

function jitter(base: number): Promise<void> {
  const delta = base * 0.5
  const ms = base + (Math.random() * 2 - 1) * delta
  return new Promise((r) => setTimeout(r, Math.max(50, ms)))
}

// Spawn workers
const workers: Promise<void>[] = []
for (let i = 0; i < args.concurrency; i++) workers.push(worker())
await Promise.all(workers)

saver.flush()
log.close()
lock.release()

// Final summary
console.log("\n" + renderProgress())
console.log(`\nstate: ${stateRoot}/.lyrics-populator-state.json`)
console.log(`log:   ${stateRoot}/.lyrics-populator.log.jsonl`)
const failed =
  Object.values(state.entries).filter((e) => e.status === LyricsStatus.PopulateFailed).length
Deno.exit(failed > 0 ? 1 : 0)
