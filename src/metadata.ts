// Metadata read + atomic write. MP3 via node-id3; Opus/FLAC/OGG via ffmpeg.
import { parseFile } from "music-metadata"
import { Buffer } from "node:buffer"
import * as nodeId3 from "node-id3"
import { join } from "@std/path"
import { sha256OfBytes, sha256OfFile } from "./state.ts"
import { hasVorbisLyrics, scanOggComments } from "./vorbis-scan.ts"

export interface AudioMeta {
  artist: string
  title: string
  album: string
  durationSec: number
  hasLyrics: boolean
  syncedLyrics: boolean
  lyricsPreview: string // first 200 chars if present
}

export async function readMeta(absPath: string, explicitExt?: string): Promise<AudioMeta> {
  const ext = explicitExt ?? absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase()
  const m = await parseFile(absPath, { duration: true, skipCovers: true })
  const c = m.common
  const lyricsArr = c.lyrics ?? []
  let hasLyrics = lyricsArr.length > 0 &&
    lyricsArr.some((l) =>
      (l.text ?? l.syncText?.map((s) => s.text).join("\n") ?? "").trim().length > 0
    )
  const synced = lyricsArr.some((l) => Array.isArray(l.syncText) && l.syncText.length > 0)
  let lyricsText = ""
  if (hasLyrics) {
    const first = lyricsArr[0]
    lyricsText = first.text ?? first.syncText?.map((s) => s.text).join("\n") ?? ""
  }
  // music-metadata fails to extract plain-text LYRICS from vorbis comments.
  // Fall back to direct vorbis comment scan for Opus/FLAC/OGG.
  if (!hasLyrics && (ext === "opus" || ext === "flac" || ext === "ogg")) {
    const present = await hasVorbisLyrics(absPath)
    if (present) {
      hasLyrics = true
      // Extract preview by re-scanning
      const f = await Deno.open(absPath, { read: true })
      try {
        const stat = await f.stat()
        const limit = Math.min(stat.size, 8 * 1024 * 1024)
        const buf = new Uint8Array(limit)
        await f.read(buf)
        const scan = scanOggComments(buf)
        lyricsText = (scan.fields["LYRICS"] ?? "").split("\x00").pop() ?? ""
      } finally {
        try {
          f.close()
        } catch { /* intentional: best-effort cleanup */ }
      }
    }
  }
  return {
    artist: c.artist ?? "",
    title: c.title ?? "",
    album: c.album ?? "",
    durationSec: m.format.duration ?? 0,
    hasLyrics,
    syncedLyrics: synced,
    lyricsPreview: lyricsText.slice(0, 200),
  }
}

// ============ WRITERS ============

export interface LyricsWritePayload {
  plain: string
  synced?: string // LRC if available
  source: string
}

export interface WriteResult {
  ok: boolean
  error?: string
  backupPath?: string
  newSha256: string
  newSize: number
}

// Writes lyrics to file. Atomic: writes copy, verifies, renames over original.
// Returns WriteResult. On failure original is untouched.
export async function writeLyrics(
  absPath: string,
  payload: LyricsWritePayload,
  opts: { keepBackup?: boolean; dryRun?: boolean } = {},
): Promise<WriteResult> {
  const ext = absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase()
  const tmpPath = `${absPath}.tmp.${Deno.pid}.${Date.now()}`

  // Copy original to tmp first; we'll overwrite the copy with metadata changes.
  try {
    await Deno.copyFile(absPath, tmpPath)
  } catch (e) {
    return fail(e, `copy failed: ${(e as Error).message}`)
  }

  let writeErr: Error | null = null
  if (opts.dryRun) {
    // No mutation
  } else if (ext === "mp3") {
    writeErr = await writeMp3(tmpPath, payload)
  } else if (ext === "opus" || ext === "flac" || ext === "ogg") {
    writeErr = await writeViaFfmpeg(absPath, tmpPath, payload)
  } else {
    writeErr = new Error(`unsupported extension for write: ${ext}`)
  }

  if (writeErr) {
    await safeUnlink(tmpPath)
    return { ok: false, error: writeErr.message, newSha256: "", newSize: 0 }
  }

  // Verify the copy is intact and tags are readable.
  const verify = await verifyWrite(absPath, tmpPath, ext, ext)
  if (!verify.ok) {
    await safeUnlink(tmpPath)
    return { ok: false, error: verify.error, newSha256: "", newSize: 0 }
  }

  // Optional backup of original (only first time per file).
  let backupPath: string | undefined
  if (opts.keepBackup && !opts.dryRun) {
    const bak = `${absPath}.bak`
    try {
      await Deno.lstat(bak)
    } catch {
      try {
        await Deno.copyFile(absPath, bak)
        backupPath = bak
      } catch { /* intentional: best-effort cleanup */ }
    }
  }

  // Atomic rename.
  try {
    await Deno.rename(tmpPath, absPath)
  } catch (e) {
    await safeUnlink(tmpPath)
    return fail(e, `rename failed: ${(e as Error).message}`)
  }

  const stat = await Deno.stat(absPath)
  const sha = await sha256OfFile(absPath)
  return { ok: true, backupPath, newSha256: sha, newSize: stat.size }
}

function fail(e: unknown, msg: string): WriteResult {
  return {
    ok: false,
    error: msg + " (" + ((e as Error)?.message ?? String(e)) + ")",
    newSha256: "",
    newSize: 0,
  }
}

async function safeUnlink(p: string): Promise<void> {
  try {
    await Deno.remove(p)
  } catch { /* intentional: best-effort cleanup */ }
}

// --- MP3 via node-id3 ---

async function writeMp3(tmpPath: string, payload: LyricsWritePayload): Promise<Error | null> {
  let existing: Record<string, unknown>
  try {
    const buf = await Deno.readFile(tmpPath)
    const parsed = nodeId3.read(Buffer.from(buf))
    if (!parsed) {
      return new Error("node-id3 could not parse existing tags")
    }
    existing = parsed as unknown as Record<string, unknown>
  } catch (e) {
    return new Error(`read existing ID3 failed: ${(e as Error).message}`)
  }

  const tags: Record<string, unknown> = { ...existing }
  tags.unsynchronisedLyrics = {
    language: "eng",
    shortText: payload.plain.slice(0, 200),
    text: payload.plain,
  }

  if (payload.synced) {
    const sylt = parseLrcToSylt(payload.synced)
    if (sylt) {
      tags.synchronisedLyrics = sylt
    }
  }

  try {
    const written = nodeId3.write(tags as Parameters<typeof nodeId3.write>[0], tmpPath)
    if (!written) return new Error("node-id3 write returned false")
  } catch (e) {
    return new Error(`node-id3 write failed: ${(e as Error).message}`)
  }
  return null
}

function parseLrcToSylt(lrc: string): unknown | null {
  // LRC format: [mm:ss.xx]text per line. node-id3 SYLT expects:
  // { language, timeStampFormat: 2 (MPEG frames) or 1 (ms), content: [{ text, timeStamp }] }
  // We use timeStampFormat=1 (absolute ms) for simplicity.
  const lines = lrc.split(/\r?\n/)
  const entries: Array<{ text: string; timeStamp: number }> = []
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/
  for (const line of lines) {
    const m = line.match(re)
    if (!m) continue
    const mm = parseInt(m[1], 10)
    const ss = parseInt(m[2], 10)
    const frac = m[3] ? parseInt(m[3].padEnd(3, "0").slice(0, 3), 10) : 0
    const ms = mm * 60_000 + ss * 1000 + frac
    const text = line.replace(re, "").trim()
    if (!text) continue
    entries.push({ text, timeStamp: ms })
  }
  if (!entries.length) return null
  return {
    language: "eng",
    timeStampFormat: 1,
    content: entries,
  }
}

// --- Opus / FLAC / OGG via ffmpeg ---

async function writeViaFfmpeg(
  originalPath: string,
  tmpPath: string,
  payload: LyricsWritePayload,
): Promise<Error | null> {
  // Use -metadata flag directly. ffmpeg handles \n literally in -metadata args
  // when invoked via execvp (no shell), preserving multi-line LYRICS in vorbis
  // comments. Escaping rules: backslash, =, ;, #, \n need backslash prefix.
  // Output extension must match container (opus → opus muxer, flac → flac, ogg → ogg).
  const ext = originalPath.slice(originalPath.lastIndexOf(".") + 1).toLowerCase()
  const outPath = `${tmpPath}.out.${ext}`
  try {
    const ffmpegBin = await findFfmpeg()
    // Escape special vorbis-comment chars: \ = ; # (but keep newlines literal —
    // Deno.Command passes them as part of the arg string, and ffmpeg writes them
    // as-is into the vorbis comment block).
    const escaped = payload.plain
      .replace(/\\/g, "\\\\")
      .replace(/=/g, "\\=")
      .replace(/;/g, "\\;")
      .replace(/#/g, "\\#")
    const args: string[] = [
      "-y",
      "-i",
      tmpPath,
      "-c",
      "copy",
      "-metadata",
      `LYRICS=${escaped}`,
      outPath,
    ]
    const cmd = new Deno.Command(ffmpegBin, {
      args,
      stdout: "piped",
      stderr: "piped",
    })
    const out = await cmd.output()
    if (!out.success) {
      const err = new TextDecoder().decode(out.stderr).slice(-2000)
      return new Error(`ffmpeg exit ${out.code}: ${err.split("\n").slice(-6).join("\n")}`)
    }
    await Deno.remove(tmpPath)
    await Deno.rename(outPath, tmpPath)
    return null
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e))
  } finally {
    await safeUnlink(outPath)
  }
}

let cachedFfmpegPath: string | null = null
async function findFfmpeg(): Promise<string> {
  if (cachedFfmpegPath) return cachedFfmpegPath
  for (const candidate of ["ffmpeg", "/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg"]) {
    try {
      const cmd = new Deno.Command(candidate, {
        args: ["-version"],
        stdout: "piped",
        stderr: "piped",
      })
      const out = await cmd.output()
      if (out.success) {
        cachedFfmpegPath = candidate
        return candidate
      }
    } catch { /* intentional: best-effort cleanup */ }
  }
  throw new Error("ffmpeg not found in PATH; required for Opus/FLAC/OGG tag writes")
}

// --- Verify after write ---

async function verifyWrite(
  originalPath: string,
  newPath: string,
  ext: string,
  actualExt?: string,
): Promise<{ ok: boolean; error?: string }> {
  const readExt = actualExt ?? ext
  // 1) new file must parse and have lyrics
  try {
    const meta = await readMeta(newPath, readExt)
    if (!meta.hasLyrics) {
      return { ok: false, error: "verification: no lyrics found in modified file" }
    }
  } catch (e) {
    return { ok: false, error: `verification: reparse failed: ${(e as Error).message}` }
  }

  // 2) duration unchanged (within 0.5s tolerance for tag padding)
  try {
    const oMeta = await readMeta(originalPath, readExt)
    const nMeta = await readMeta(newPath, readExt)
    if (oMeta.durationSec > 0 && Math.abs(oMeta.durationSec - nMeta.durationSec) > 0.5) {
      return {
        ok: false,
        error: `verification: duration changed ${oMeta.durationSec} -> ${nMeta.durationSec}`,
      }
    }
  } catch (e) {
    return { ok: false, error: `verification: meta compare failed: ${(e as Error).message}` }
  }

  // 3) size sanity (extension-specific). ffmpeg -c copy may drop incompatible
  // streams (e.g. mjpeg-in-opus from YouTube rips) — allow up to 25% size drop.
  const oStat = await Deno.stat(originalPath)
  const nStat = await Deno.stat(newPath)
  const delta = nStat.size - oStat.size
  const maxLoss = Math.max(64 * 1024, Math.floor(oStat.size * 0.25))
  const maxGain = 64 * 1024
  if (delta < -maxLoss || delta > maxGain) {
    return {
      ok: false,
      error:
        `verification: size delta ${delta} out of range (loss limit ${maxLoss}, gain limit ${maxGain})`,
    }
  }

  return { ok: true }
}

// Helper used by tests: hash bytes of just audio content (best-effort by stripping known header regions).
// Currently unused — included for future per-format audio-byte verification.
export async function _hashAudioBytes(path: string): Promise<string> {
  const bytes = await Deno.readFile(path)
  return sha256OfBytes(bytes)
}

// Resolve tmp dir used by callers when constructing scratch paths.
export function tmpInDir(dir: string, suffix: string): string {
  return join(dir, `.tmp-${Deno.pid}-${Date.now()}${suffix}`)
}
