// Pure-TS OggS vorbis comment writer. Modifies the vorbis comment block of an
// Ogg/Opus file without re-encoding audio.
//
// Why: ffmpeg's `-c copy -metadata X=Y` does NOT reliably update vorbis comment
// values when the source already has the same key. We need to rewrite the
// vorbis comment block directly.
//
// Approach:
//   1. Find vorbis comment page (Opus = page index 1; FLAC = page index 1; OGG = page index 1)
//   2. Parse existing comment entries
//   3. Apply overrides (replace matching keys)
//   4. Repack the page with new size + new segment table
//   5. Recompute page CRC32 (only this page; audio pages after are untouched)
//   6. Splice back into the original file

import { readU32LE } from "./vorbis-scan.ts"

function _u32(buf: Uint8Array, off: number): number {
  // Same as vorbis-scan.readU32LE — local copy to avoid import cycle risk.
  return buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | ((buf[off + 3] << 24) >>> 0)
}

// CRC32 lookup table for OggS (polynomial 0x04C11DB7).
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n << 24
    for (let k = 0; k < 8; k++) {
      c = (c & 0x80000000) !== 0 ? ((c << 1) ^ 0x04C11DB7) : (c << 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xff]) >>> 0
  }
  return crc
}

// Find the vorbis comment page in an Ogg stream.
// Returns [pageStart, pageEnd, pageBytes] or null if not found.
function findVorbisCommentPage(
  bytes: Uint8Array,
): { pageStart: number; pageEnd: number; pageBytes: Uint8Array } | null {
  let i = 0
  while (i < bytes.length - 27) {
    if (
      bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53 &&
      bytes[i + 4] === 0
    ) {
      const nsegs = bytes[i + 26]
      if (i + 27 + nsegs > bytes.length) return null
      let segTotal = 0
      for (let k = 0; k < nsegs; k++) segTotal += bytes[i + 27 + k]
      const bodyStart = i + 27 + nsegs
      if (bodyStart + segTotal > bytes.length) return null
      const body = bytes.subarray(bodyStart, bodyStart + segTotal)
      // OpusTags = "OpusTags" (0x4f 0x70 0x75 0x73 0x54 0x61 0x67 0x73)
      // Vorbis comment = "vorbis" (0x76 0x6f 0x72 0x62 0x69 0x73)
      const isOpusTags = body[0] === 0x4f && body[1] === 0x70 && body[2] === 0x75 &&
        body[3] === 0x73 && body[4] === 0x54 && body[5] === 0x61 && body[6] === 0x67 &&
        body[7] === 0x73
      const isVorbis = body[0] === 0x76 && body[1] === 0x6f && body[2] === 0x72 &&
        body[3] === 0x62 && body[4] === 0x69 && body[5] === 0x73
      if (isOpusTags || isVorbis) {
        return {
          pageStart: i,
          pageEnd: bodyStart + segTotal,
          pageBytes: bytes.subarray(i, bodyStart + segTotal),
        }
      }
      i = bodyStart + segTotal
      continue
    }
    i++
  }
  return null
}

interface CommentEntry {
  key: string
  value: string
}

function decodeComments(body: Uint8Array, magicLen: number): {
  vendor: string
  entries: CommentEntry[]
} {
  let off = magicLen
  const vendorLen = readU32LE(body, off)
  off += 4
  const vendor = new TextDecoder("utf-8", { fatal: false }).decode(
    body.subarray(off, off + vendorLen),
  )
  off += vendorLen
  const count = readU32LE(body, off)
  off += 4
  const entries: CommentEntry[] = []
  for (let n = 0; n < count; n++) {
    if (off + 4 > body.length) break
    const clen = readU32LE(body, off)
    off += 4
    if (off + clen > body.length) break
    const raw = body.subarray(off, off + clen)
    off += clen
    const text = new TextDecoder("utf-8", { fatal: false }).decode(raw)
    const eq = text.indexOf("=")
    if (eq > 0) {
      entries.push({ key: text.slice(0, eq), value: text.slice(eq + 1) })
    }
  }
  return { vendor, entries }
}

function encodeComments(
  vendor: string,
  entries: CommentEntry[],
  magic: Uint8Array,
): Uint8Array {
  const enc = new TextEncoder()
  const parts: number[] = []
  for (const b of magic) parts.push(b)
  // vendor length + vendor
  const vendorBytes = enc.encode(vendor)
  parts.push(
    vendorBytes.length & 0xff,
    (vendorBytes.length >> 8) & 0xff,
    (vendorBytes.length >> 16) & 0xff,
    (vendorBytes.length >> 24) & 0xff,
  )
  for (const b of vendorBytes) parts.push(b)
  // count
  parts.push(
    entries.length & 0xff,
    (entries.length >> 8) & 0xff,
    (entries.length >> 16) & 0xff,
    (entries.length >> 24) & 0xff,
  )
  for (const e of entries) {
    const valueBytes = enc.encode(`${e.key}=${e.value}`)
    parts.push(
      valueBytes.length & 0xff,
      (valueBytes.length >> 8) & 0xff,
      (valueBytes.length >> 16) & 0xff,
      (valueBytes.length >> 24) & 0xff,
    )
    for (const b of valueBytes) parts.push(b)
  }
  return new Uint8Array(parts)
}

// Pack vorbis comment body into an OggS page. Returns the full page bytes
// (header + segment table + body) with the page CRC computed.
function packOggPage(
  header: { serial: number; pageSeq: number; granule: bigint; flags: number },
  body: Uint8Array,
): Uint8Array {
  const HEADER_SIZE = 27
  // Split body into segments of 255 bytes max
  const segValues: number[] = []
  let rem = body.length
  while (rem >= 255) {
    segValues.push(255)
    rem -= 255
  }
  segValues.push(rem)
  const segTableLen = segValues.length
  const totalPageSize = HEADER_SIZE + segTableLen + body.length

  const out = new Uint8Array(totalPageSize)
  // "OggS"
  out[0] = 0x4f
  out[1] = 0x67
  out[2] = 0x67
  out[3] = 0x53
  out[4] = 0 // version
  out[5] = header.flags // flags (carry over from original page)
  // granule (8 bytes)
  const g = header.granule
  out[6] = Number(g & 0xffn)
  out[7] = Number((g >> 8n) & 0xffn)
  out[8] = Number((g >> 16n) & 0xffn)
  out[9] = Number((g >> 24n) & 0xffn)
  out[10] = Number((g >> 32n) & 0xffn)
  out[11] = Number((g >> 40n) & 0xffn)
  out[12] = Number((g >> 48n) & 0xffn)
  out[13] = Number((g >> 56n) & 0xffn)
  // serial (4 bytes LE)
  out[14] = header.serial & 0xff
  out[15] = (header.serial >> 8) & 0xff
  out[16] = (header.serial >> 16) & 0xff
  out[17] = (header.serial >> 24) & 0xff
  // page seq (4 bytes LE)
  out[18] = header.pageSeq & 0xff
  out[19] = (header.pageSeq >> 8) & 0xff
  out[20] = (header.pageSeq >> 16) & 0xff
  out[21] = (header.pageSeq >> 24) & 0xff
  // CRC placeholder (bytes 22-25, computed below)
  // nsegs
  out[26] = segTableLen
  // segment table
  for (let k = 0; k < segTableLen; k++) out[27 + k] = segValues[k]
  // body
  out.set(body, HEADER_SIZE + segTableLen)
  // CRC
  const c = crc32(out)
  out[22] = c & 0xff
  out[23] = (c >> 8) & 0xff
  out[24] = (c >> 16) & 0xff
  out[25] = (c >> 24) & 0xff
  return out
}

// Apply field overrides to a vorbis comment block body.
// overrides is a map of key -> new value. Keys already present are replaced;
// new keys are appended. All other existing entries are kept as-is.
function applyOverrides(
  vendor: string,
  entries: CommentEntry[],
  overrides: Map<string, string>,
  _preserveKeys: Set<string>,
): CommentEntry[] {
  const out: CommentEntry[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    const upper = e.key.toUpperCase()
    if (overrides.has(upper)) {
      out.push({ key: e.key, value: overrides.get(upper)! })
    } else {
      out.push(e)
    }
    seen.add(upper)
  }
  // Append any overrides that didn't match existing keys
  for (const [k, v] of overrides) {
    if (!seen.has(k.toUpperCase())) {
      out.push({ key: k, value: v })
    }
  }
  return out
}

// Public API: rewrite vorbis comments in an Ogg file.
// `bytes` = the full file bytes (Uint8Array, mutable).
// `overrides` = map of uppercase field name to new value (e.g. "ARTIST" -> "Bruno Major")
// `preserveKeys` = uppercase keys that should be kept as-is even if not in overrides
// Returns the modified file bytes (always a new Uint8Array; original unchanged).
export function rewriteVorbisComments(
  bytes: Uint8Array,
  overrides: Map<string, string>,
  preserveKeys: Set<string>,
): Uint8Array {
  const page = findVorbisCommentPage(bytes)
  if (!page) throw new Error("vorbis comment page not found")

  const body = bytes.subarray(page.pageStart, page.pageEnd)
  // Decode header
  const headerFlags = body[5]
  // granule: 8 bytes LE
  let g = 0n
  for (let k = 0; k < 8; k++) g |= BigInt(body[6 + k]) << BigInt(k * 8)
  const serial = readU32LE(body, 14)
  const pageSeq = readU32LE(body, 18)

  // Body starts after header (27) + segment table
  const nsegs = body[26]
  const bodyStart = 27 + nsegs
  const pageBody = body.subarray(bodyStart)

  // Determine magic length
  const magicLen = pageBody[0] === 0x4f && pageBody[1] === 0x70 ? 8 : 6
  const magic = pageBody.slice(0, magicLen)

  const { vendor, entries } = decodeComments(pageBody, magicLen)
  const newEntries = applyOverrides(vendor, entries, overrides, preserveKeys)
  const newBody = encodeComments(vendor, newEntries, magic)

  const newPage = packOggPage(
    { serial, pageSeq, granule: g, flags: headerFlags },
    newBody,
  )

  // Splice: [before] + [newPage] + [after]
  const before = bytes.subarray(0, page.pageStart)
  const after = bytes.subarray(page.pageEnd)
  const out = new Uint8Array(before.length + newPage.length + after.length)
  out.set(before, 0)
  out.set(newPage, before.length)
  out.set(after, before.length + newPage.length)
  return out
}
