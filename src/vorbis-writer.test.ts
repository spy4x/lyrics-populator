import { assertEquals, assertExists } from "@std/assert"
import { scanOggComments } from "./vorbis-scan.ts"
import { rewriteVorbisComments } from "./vorbis-writer.ts"

// Synthesize a minimal Ogg/Opus-like file with a vorbis comment block.
function buildOggWithComment(vendor: string, comments: Record<string, string>): Uint8Array {
  const enc = new TextEncoder()
  const parts: number[] = []
  for (const c of "OpusTags") parts.push(c.charCodeAt(0))
  const vendorBytes = enc.encode(vendor)
  parts.push(vendorBytes.length & 0xff, (vendorBytes.length >> 8) & 0xff, 0, 0)
  for (const b of vendorBytes) parts.push(b)
  const keys = Object.keys(comments)
  parts.push(keys.length & 0xff, (keys.length >> 8) & 0xff, 0, 0)
  for (const k of keys) {
    const v = comments[k]
    const valBytes = enc.encode(`${k}=${v}`)
    parts.push(valBytes.length & 0xff, (valBytes.length >> 8) & 0xff, 0, 0)
    for (const b of valBytes) parts.push(b)
  }
  const body = new Uint8Array(parts)

  // Build one segment-table entry whose value is body length (< 255 needed).
  const segValues: number[] = []
  let rem = body.length
  while (rem >= 255) { segValues.push(255); rem -= 255 }
  segValues.push(rem)

  const header = new Uint8Array(27)
  header[0] = 0x4f; header[1] = 0x67; header[2] = 0x67; header[3] = 0x53
  header[4] = 0; header[5] = 0
  header[14] = 1 // serial
  header[18] = 1 // page seq
  header[26] = segValues.length
  const segTable = new Uint8Array(segValues)
  const page = new Uint8Array(27 + segTable.length + body.length)
  page.set(header, 0)
  page.set(segTable, 27)
  page.set(body, 27 + segTable.length)
  // CRC placeholder will be wrong but we only test scanOggComments path.
  return page
}

Deno.test("rewriteVorbisComments replaces existing key value", () => {
  const data = buildOggWithComment("TestVendor", {
    TITLE: "Original Title",
    ARTIST: "Original Artist",
    GENRE: "Rock",
  })
  const overrides = new Map<string, string>([["ARTIST", "New Artist"]])
  const preserve = new Set<string>(["TITLE", "GENRE"])
  const out = rewriteVorbisComments(data, overrides, preserve)
  const scan = scanOggComments(out)
  assertEquals(scan.fields["ARTIST"], "New Artist")
  assertEquals(scan.fields["TITLE"], "Original Title")
  assertEquals(scan.fields["GENRE"], "Rock")
})

Deno.test("rewriteVorbisComments appends new key", () => {
  const data = buildOggWithComment("v", { TITLE: "T" })
  const overrides = new Map<string, string>([["ALBUM", "New Album"], ["DATE", "2025"]])
  const preserve = new Set<string>()
  const out = rewriteVorbisComments(data, overrides, preserve)
  const scan = scanOggComments(out)
  assertEquals(scan.fields["ALBUM"], "New Album")
  assertEquals(scan.fields["DATE"], "2025")
  assertEquals(scan.fields["TITLE"], "T")
})

Deno.test("rewriteVorbisComments keeps all existing entries by default", () => {
  // We no longer drop non-overridden, non-preserved entries — they stay
  // as-is. This avoids losing metadata unintentionally.
  const data = buildOggWithComment("v", {
    TITLE: "T",
    ARTIST: "A",
    PURL: "https://example.com",
    DESCRIPTION: "old",
  })
  const overrides = new Map<string, string>([["ARTIST", "New"]])
  const preserve = new Set<string>()
  const out = rewriteVorbisComments(data, overrides, preserve)
  const scan = scanOggComments(out)
  assertEquals(scan.fields["ARTIST"], "New")
  assertEquals(scan.fields["TITLE"], "T")
  assertEquals(scan.fields["PURL"], "https://example.com")
  assertEquals(scan.fields["DESCRIPTION"], "old")
})

Deno.test("rewriteVorbisComments preserves vendor string", () => {
  const data = buildOggWithComment("Lavf60.16.100", { TITLE: "T" })
  const overrides = new Map<string, string>([["TITLE", "New"]])
  const preserve = new Set<string>()
  const out = rewriteVorbisComments(data, overrides, preserve)
  const scan = scanOggComments(out)
  assertEquals(scan.vendor, "Lavf60.16.100")
  assertEquals(scan.fields["TITLE"], "New")
})

Deno.test("rewriteVorbisComments handles multi-value LYRICS correctly", () => {
  const data = buildOggWithComment("v", {
    LYRICS: "old line 1\nold line 2",
    ARTIST: "x",
  })
  const overrides = new Map<string, string>([["LYRICS", "new\nlines"]])
  const preserve = new Set<string>()
  const out = rewriteVorbisComments(data, overrides, preserve)
  const scan = scanOggComments(out)
  // Multi-value LYRICS is split by \x00 separator (per spec). Our writer
  // produces single value, so check raw value.
  assertEquals(scan.fields["LYRICS"], "new\nlines")
})

Deno.test("rewriteVorbisComments throws when no comment page", () => {
  // Empty bytes — no OggS pages at all
  const data = new Uint8Array([1, 2, 3])
  let err = ""
  try {
    rewriteVorbisComments(data, new Map(), new Set())
  } catch (e) {
    err = (e as Error).message
  }
  assertExists(err)
  assertEquals(err.includes("not found"), true)
})
