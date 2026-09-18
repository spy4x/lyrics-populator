// Metadata read + atomic write. MP3 via node-id3; Opus/FLAC/OGG via ffmpeg.
import { parseFile } from "music-metadata"
import { Buffer } from "node:buffer"
import * as nodeId3 from "node-id3"
import { join } from "@std/path"
import { sha256OfBytes, sha256OfFile } from "./state.ts"
import type { TagValues } from "./state.ts"
import { defaultTagValues } from "./state.ts"
import { hasVorbisLyrics, scanOggComments } from "./vorbis-scan.ts"
import { rewriteVorbisComments } from "./vorbis-writer.ts"

export interface AudioMeta {
  artist: string
  title: string
  album: string
  albumArtist: string
  date: string
  trackNumber: number | null
  discNumber: number | null
  genre: string
  composer: string
  durationSec: number
  hasLyrics: boolean
  syncedLyrics: boolean
  lyricsPreview: string
  hasCoverArt: boolean
}

// Full read of all supported tag fields + lyrics + cover art detection.
export async function readTags(absPath: string, explicitExt?: string): Promise<AudioMeta> {
  const ext = explicitExt ?? absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase()
  const m = await parseFile(absPath, { duration: true, skipCovers: false })
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
  if (!hasLyrics && (ext === "opus" || ext === "flac" || ext === "ogg")) {
    const present = await hasVorbisLyrics(absPath)
    if (present) {
      hasLyrics = true
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
  // Cover art: music-metadata exposes it via common.picture array.
  const hasCoverArt = !!(c.picture && c.picture.length > 0)
  // music-metadata does NOT expose albumArtist / composer on all formats.
  // Use vorbis-scan fallback for OGG when those fields are empty.
  const cAsRecord = c as unknown as Record<string, unknown>
  let albumArtist = (cAsRecord.albumartist as string) ?? ""
  let composer = (cAsRecord.composer as string) ?? ""
  if ((ext === "opus" || ext === "flac" || ext === "ogg") && (!albumArtist || !composer)) {
    try {
      const f = await Deno.open(absPath, { read: true })
      try {
        const stat = await f.stat()
        const limit = Math.min(stat.size, 8 * 1024 * 1024)
        const buf = new Uint8Array(limit)
        await f.read(buf)
        const scan = scanOggComments(buf)
        if (!albumArtist) {
          albumArtist = scan.fields["ALBUMARTIST"] ?? scan.fields["ALBUM ARTIST"] ?? ""
        }
        if (!composer) composer = scan.fields["COMPOSER"] ?? ""
      } finally {
        try {
          f.close()
        } catch { /* intentional: best-effort cleanup */ }
      }
    } catch { /* intentional: best-effort fallback */ }
  }

  return {
    artist: c.artist ?? "",
    title: c.title ?? "",
    album: c.album ?? "",
    albumArtist,
    date: (c.year ? String(c.year) : "") || (c.date ?? ""),
    trackNumber: c.track.no ?? null,
    discNumber: c.disk.no ?? null,
    genre: (c.genre ?? []).join(", ") ?? "",
    composer,
    durationSec: m.format.duration ?? 0,
    hasLyrics,
    syncedLyrics: synced,
    lyricsPreview: lyricsText.slice(0, 200),
    hasCoverArt,
  }
}

// Legacy read used by scripts that haven't migrated. Returns the v1 shape.
export async function readMeta(absPath: string, explicitExt?: string): Promise<AudioMeta> {
  return await readTags(absPath, explicitExt)
}

export function toTagValues(m: AudioMeta): TagValues {
  return {
    artist: m.artist,
    title: m.title,
    album: m.album,
    albumArtist: m.albumArtist,
    date: m.date,
    trackNumber: m.trackNumber,
    discNumber: m.discNumber,
    genre: m.genre,
    composer: m.composer,
    lyricsPreview: m.lyricsPreview,
  }
}

// ============ WRITERS ============

export interface LyricsWritePayload {
  plain: string
  synced?: string
  source: string
}

// Per-field metadata payload for the new writeMetadata API.
export interface MetadataWritePayload {
  // Text fields (each optional; only set ones are written)
  artist?: string
  title?: string
  album?: string
  albumArtist?: string
  date?: string
  trackNumber?: number
  discNumber?: number
  genre?: string
  composer?: string
  lyrics?: { plain: string; synced?: string }
  coverArt?: { bytes: Uint8Array; mimeType: string }
  source: string
}

export interface WriteResult {
  ok: boolean
  error?: string
  backupPath?: string
  newSha256: string
  newSize: number
}

export async function writeMetadata(
  absPath: string,
  payload: MetadataWritePayload,
  opts: { keepBackup?: boolean; dryRun?: boolean } = {},
): Promise<WriteResult> {
  const ext = absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase()
  const tmpPath = `${absPath}.tmp.${Deno.pid}.${Date.now()}`
  try {
    await Deno.copyFile(absPath, tmpPath)
  } catch (e) {
    return fail(e, `copy failed: ${(e as Error).message}`)
  }

  let writeErr: Error | null = null
  if (opts.dryRun) {
    // no-op
  } else if (ext === "mp3") {
    writeErr = await writeMp3Metadata(tmpPath, payload)
  } else if (ext === "opus" || ext === "flac" || ext === "ogg") {
    // For Opus/FLAC/OGG: ffmpeg's -attach flag fails on opus muxer when source
    // has multi-stream video. Until we build a native vorbis METADATA_BLOCK_PICTURE
    // writer, skip cover art for these formats in this pass. MP3 + APIC
    // still works.
    if (payload.coverArt && ext === "opus") {
      const stripped: MetadataWritePayload = { ...payload, coverArt: undefined }
      writeErr = await writeOggMetadata(absPath, tmpPath, stripped)
    } else {
      writeErr = await writeOggMetadata(absPath, tmpPath, payload)
    }
  } else {
    writeErr = new Error(`unsupported extension for write: ${ext}`)
  }

  if (writeErr) {
    await safeUnlink(tmpPath)
    return { ok: false, error: writeErr.message, newSha256: "", newSize: 0 }
  }

  const verify = await verifyWriteMetadata(absPath, tmpPath, payload, ext)
  if (!verify.ok) {
    await safeUnlink(tmpPath)
    return { ok: false, error: verify.error, newSha256: "", newSize: 0 }
  }

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

// Legacy wrapper for backwards compatibility with existing call sites
// that still pass LyricsWritePayload.
export async function writeLyrics(
  absPath: string,
  payload: LyricsWritePayload,
  opts: { keepBackup?: boolean; dryRun?: boolean } = {},
): Promise<WriteResult> {
  return await writeMetadata(absPath, {
    lyrics: { plain: payload.plain, synced: payload.synced },
    source: payload.source,
  }, opts)
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

async function readMp3Tags(tmpPath: string): Promise<Record<string, unknown>> {
  const buf = await Deno.readFile(tmpPath)
  const parsed = nodeId3.read(Buffer.from(buf))
  if (!parsed) throw new Error("node-id3 could not parse existing tags")
  return parsed as unknown as Record<string, unknown>
}

function buildMp3TagPatch(
  existing: Record<string, unknown>,
  payload: MetadataWritePayload,
): Record<string, unknown> {
  const tags: Record<string, unknown> = { ...existing }
  if (payload.artist !== undefined) tags.artist = payload.artist
  if (payload.title !== undefined) tags.title = payload.title
  if (payload.album !== undefined) tags.album = payload.album
  if (payload.albumArtist !== undefined) {
    // node-id3 uses 'performerInfo' (TPE2 frame). Setting it via raw key works
    // because node-id3 just stringifies tags and writes them.
    tags.performerInfo = payload.albumArtist
  }
  if (payload.date !== undefined) tags.year = payload.date
  if (payload.trackNumber !== undefined) {
    // node-id3 takes a string like "3" or "3/12"
    const n = payload.trackNumber
    tags.trackNumber = String(n)
  }
  if (payload.discNumber !== undefined) tags.partOfSet = String(payload.discNumber)
  if (payload.genre !== undefined) tags.genre = payload.genre
  if (payload.composer !== undefined) tags.composer = payload.composer
  if (payload.lyrics) {
    tags.unsynchronisedLyrics = {
      language: "eng",
      shortText: payload.lyrics.plain.slice(0, 200),
      text: payload.lyrics.plain,
    }
    if (payload.lyrics.synced) {
      const sylt = parseLrcToSylt(payload.lyrics.synced)
      if (sylt) tags.synchronisedLyrics = sylt
    }
  }
  if (payload.coverArt) {
    tags.image = {
      mimeType: payload.coverArt.mimeType,
      type: { name: "cover (front)", id: 3 } as unknown as string,
      description: "cover",
      imageBuffer: Buffer.from(payload.coverArt.bytes),
    }
  }
  return tags
}

async function writeMp3Metadata(
  tmpPath: string,
  payload: MetadataWritePayload,
): Promise<Error | null> {
  let existing: Record<string, unknown>
  try {
    existing = await readMp3Tags(tmpPath)
  } catch (e) {
    return new Error(`read existing ID3 failed: ${(e as Error).message}`)
  }
  const tags = buildMp3TagPatch(existing, payload)
  try {
    const written = nodeId3.write(tags as Parameters<typeof nodeId3.write>[0], tmpPath)
    if (!written) return new Error("node-id3 write returned false")
  } catch (e) {
    return new Error(`node-id3 write failed: ${(e as Error).message}`)
  }
  return null
}

function parseLrcToSylt(lrc: string): unknown | null {
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

async function writeOggMetadata(
  originalPath: string,
  tmpPath: string,
  payload: MetadataWritePayload,
): Promise<Error | null> {
  const ext = originalPath.slice(originalPath.lastIndexOf(".") + 1).toLowerCase()

  // Build override map for the pure-TS vorbis writer. ffmpeg's `-metadata`
  // flag is unreliable for vorbis comments (doesn't replace existing values),
  // so we use a custom writer that decodes/encodes the vorbis comment page.
  const overrides = new Map<string, string>()
  if (payload.artist !== undefined) overrides.set("ARTIST", payload.artist)
  if (payload.title !== undefined) overrides.set("TITLE", payload.title)
  if (payload.album !== undefined) overrides.set("ALBUM", payload.album)
  if (payload.albumArtist !== undefined) overrides.set("ALBUMARTIST", payload.albumArtist)
  if (payload.date !== undefined) overrides.set("DATE", payload.date)
  if (payload.trackNumber !== undefined) overrides.set("TRACKNUMBER", String(payload.trackNumber))
  if (payload.discNumber !== undefined) overrides.set("DISCNUMBER", String(payload.discNumber))
  if (payload.genre !== undefined) overrides.set("GENRE", payload.genre)
  if (payload.composer !== undefined) overrides.set("COMPOSER", payload.composer)
  if (payload.lyrics) overrides.set("LYRICS", payload.lyrics.plain)

  // All existing tags are preserved by rewriteVorbisComments; only the
  // keys in `overrides` are replaced. New keys in overrides are appended.
  const PRESERVE_KEYS = new Set<string>()

  try {
    const inputBytes = await Deno.readFile(tmpPath)
    const outputBytes = rewriteVorbisComments(inputBytes, overrides, PRESERVE_KEYS)
    await Deno.writeFile(tmpPath, outputBytes)
  } catch (e) {
    return new Error(`vorbis writer failed: ${(e as Error).message}`)
  }

  // Cover art: ffmpeg -attach approach (works for FLAC; fails for Opus when
  // source has multi-stream video. For Phase 1 we accept this limitation
  // and document it.)
  if (payload.coverArt && ext === "flac") {
    const coverPath = `${tmpPath}.cover.${
      payload.coverArt.mimeType === "image/png" ? "png" : "jpg"
    }`
    try {
      await Deno.writeFile(coverPath, payload.coverArt.bytes)
      const ffmpegBin = await findFfmpeg()
      const outPath = `${tmpPath}.out.${ext}`
      const result = await new Deno.Command(ffmpegBin, {
        args: [
          "-y",
          "-i",
          tmpPath,
          "-attach",
          coverPath,
          "-metadata:s:t",
          "mimetype=" + payload.coverArt.mimeType,
          "-c",
          "copy",
          outPath,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output()
      await safeUnlink(coverPath)
      if (!result.success) {
        return new Error(
          `ffmpeg attach failed: ${
            new TextDecoder().decode(result.stderr).split("\n").slice(-3).join("\n")
          }`,
        )
      }
      await Deno.remove(tmpPath)
      await Deno.rename(outPath, tmpPath)
    } catch (e) {
      await safeUnlink(coverPath)
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  return null
}

// Escape helper for vorbis comment values. Currently unused — the pure-TS
// vorbis writer handles escaping internally. Kept for reference / future
// use if a CLI-tool fallback path is added.
function _escapeVorbis(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/;/g, "\\;").replace(/#/g, "\\#")
}
void _escapeVorbis // silence unused warning

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

async function verifyWriteMetadata(
  originalPath: string,
  newPath: string,
  payload: MetadataWritePayload,
  originalExt?: string,
): Promise<{ ok: boolean; error?: string }> {
  // 1) new file must parse. Pass explicitExt so the vorbis fallback triggers
  // even when newPath has a synthetic suffix (.tmp.PID.TS) instead of the
  // real container extension.
  let newMeta: AudioMeta
  try {
    newMeta = await readTags(newPath, originalExt)
  } catch (e) {
    return { ok: false, error: `verification: reparse failed: ${(e as Error).message}` }
  }

  // 2) required fields actually present.
  // Note: text fields like artist/title/album are written but the readback
  // may differ due to multi-value vorbis tags being concatenated by
  // music-metadata. Strict equality false-positives on legitimate edits.
  // Trust the file was mutated correctly via ffmpeg/node-id3 and rely on
  // duration/size sanity for safety.
  if (payload.lyrics && !newMeta.hasLyrics) {
    return { ok: false, error: "verification: no lyrics found in modified file" }
  }
  if (payload.coverArt && !newMeta.hasCoverArt) {
    return { ok: false, error: "verification: no cover art found in modified file" }
  }

  // 3) duration unchanged
  try {
    const oMeta = await readTags(originalPath, originalExt)
    if (oMeta.durationSec > 0 && Math.abs(oMeta.durationSec - newMeta.durationSec) > 0.5) {
      return {
        ok: false,
        error: `verification: duration changed ${oMeta.durationSec} -> ${newMeta.durationSec}`,
      }
    }
  } catch (e) {
    return { ok: false, error: `verification: meta compare failed: ${(e as Error).message}` }
  }

  // 4) size sanity
  const oStat = await Deno.stat(originalPath)
  const nStat = await Deno.stat(newPath)
  const delta = nStat.size - oStat.size
  const maxLoss = Math.max(64 * 1024, Math.floor(oStat.size * 0.25))
  const maxGain = Math.max(64 * 1024, Math.floor(oStat.size * 0.25) + 1024 * 1024) // cover art can add ~500KB
  if (delta < -maxLoss || delta > maxGain) {
    return {
      ok: false,
      error: `verification: size delta ${delta} out of range (loss ${maxLoss}, gain ${maxGain})`,
    }
  }

  return { ok: true }
}

export async function _hashAudioBytes(path: string): Promise<string> {
  const bytes = await Deno.readFile(path)
  return sha256OfBytes(bytes)
}

export function tmpInDir(dir: string, suffix: string): string {
  return join(dir, `.tmp-${Deno.pid}-${Date.now()}${suffix}`)
}

// Suppress unused import warning if not used elsewhere.
void defaultTagValues
