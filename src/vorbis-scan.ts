// Minimal vorbis comment scanner: extracts LYRICS= field from an Ogg container
// (Opus, FLAC, Vorbis). Used to detect preexisting lyrics that music-metadata
// fails to parse when stored as plain (non-LRC) text.
import { Buffer } from "node:buffer"

export interface VorbisCommentScan {
  vendor: string
  fields: Record<string, string>
}

function readU32LE(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | ((buf[off + 3] << 24) >>> 0)
}

// Walk Ogg pages until we consume vorbis comment header(s). Returns merged
// comment map. Skips non-comment pages (e.g. OpusHead, audio).
export function scanOggComments(bytes: Uint8Array): VorbisCommentScan {
  let i = 0
  const merged: VorbisCommentScan = { vendor: "", fields: {} }
  let foundComment = false
  let pagesScanned = 0
  const LIMIT = 8 * 1024 * 1024
  const MAX_PAGES = 16
  while (i < Math.min(bytes.length, LIMIT)) {
    pagesScanned++
    if (pagesScanned > MAX_PAGES) break
    if (
      bytes[i] !== 0x4f || bytes[i + 1] !== 0x67 || bytes[i + 2] !== 0x67 || bytes[i + 3] !== 0x53
    ) break
    if (bytes[i + 4] !== 0) break
    const nsegs = bytes[i + 26]
    if (i + 27 + nsegs > bytes.length) break
    let segTotal = 0
    for (let k = 0; k < nsegs; k++) segTotal += bytes[i + 27 + k]
    const bodyStart = i + 27 + nsegs
    const body = bytes.subarray(bodyStart, bodyStart + segTotal)
    const isLast = (bytes[i + 5] & 0x04) !== 0
    i = bodyStart + segTotal

    if (!foundComment) {
      const isOpusHead = body[0] === 0x4f && body[1] === 0x70 && body[2] === 0x75 &&
        body[3] === 0x73 && body[4] === 0x48 && body[5] === 0x65 && body[6] === 0x61 &&
        body[7] === 0x64
      const isOpusTags = body[0] === 0x4f && body[1] === 0x70 && body[2] === 0x75 &&
        body[3] === 0x73 && body[4] === 0x54 && body[5] === 0x61 && body[6] === 0x67 &&
        body[7] === 0x73
      const isVorbisId = body[0] === 0x76 && body[1] === 0x6f && body[2] === 0x72 &&
        body[3] === 0x62 && body[4] === 0x69 && body[5] === 0x73
      const isFlac = body[0] === 0x66 && body[1] === 0x4c && body[2] === 0x61 &&
        body[3] === 0x43
      const isVorbisComment = isOpusTags || isVorbisId
      if (isOpusHead || isVorbisId || isFlac) continue
      if (!isVorbisComment) break
      const dec = new TextDecoder("utf-8", { fatal: false })
      const parsed = parseCommentPacket(body, dec)
      if (!parsed) break
      merged.vendor = parsed.vendor
      Object.assign(merged.fields, parsed.fields)
      foundComment = true
      if (isLast) break
      continue
    } else {
      // Continuation: raw comment fields only (no vendor, no count)
      const dec = new TextDecoder("utf-8", { fatal: false })
      let off = 0
      let safety = 0
      while (off + 4 <= body.length) {
        if (++safety > 1000) break
        const clen = readU32LE(body, off)
        off += 4
        if (clen === 0) break
        if (off + clen > body.length) break
        const entry = dec.decode(body.subarray(off, off + clen))
        off += clen
        const eq = entry.indexOf("=")
        if (eq > 0) {
          const k = entry.slice(0, eq)
          const v = entry.slice(eq + 1)
          merged.fields[k] = (merged.fields[k] ?? "") + (merged.fields[k] ? "\x00" : "") + v
        }
      }
      if (isLast) break
    }
  }
  return merged
}

function parseCommentPacket(body: Uint8Array, dec: TextDecoder): VorbisCommentScan | null {
  let off = 0
  // magic: 6 bytes for Vorbis "vorbis", 8 bytes for "OpusTags"
  let skipMagic = 0
  if (body[0] === 0x4f && body[1] === 0x70) skipMagic = 8 // "OpusTags"
  else if (body[0] === 0x76) skipMagic = 6 // "vorbis"
  else return null
  off += skipMagic
  const vendorLen = readU32LE(body, off)
  off += 4
  if (off + vendorLen > body.length) return null
  const vendor = dec.decode(body.subarray(off, off + vendorLen))
  off += vendorLen
  const commentCount = readU32LE(body, off)
  off += 4
  const fields: Record<string, string> = {}
  for (let n = 0; n < commentCount; n++) {
    if (off + 4 > body.length) break
    const clen = readU32LE(body, off)
    off += 4
    if (off + clen > body.length) break
    const entry = dec.decode(body.subarray(off, off + clen))
    off += clen
    const eq = entry.indexOf("=")
    if (eq > 0) {
      const k = entry.slice(0, eq)
      const v = entry.slice(eq + 1)
      fields[k] = (fields[k] ?? "") + (fields[k] ? "\x00" : "") + v
    }
  }
  return { vendor, fields }
}

export async function hasVorbisLyrics(absPath: string): Promise<boolean> {
  const f = await Deno.open(absPath, { read: true })
  try {
    // Read up to 8 MB — vorbis comment block is typically first ~64 KB.
    const stat = await f.stat()
    const limit = Math.min(stat.size, 8 * 1024 * 1024)
    const buf = new Uint8Array(limit)
    await f.read(buf)
    const scan = scanOggComments(buf)
    const lyrics = scan.fields["LYRICS"]?.trim() ?? ""
    return lyrics.length > 0
  } finally {
    try {
      f.close()
    } catch { /* intentional: best-effort cleanup */ }
  }
}

// Suppress unused-var warning for Buffer import
void Buffer
