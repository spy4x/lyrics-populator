import { assertEquals } from "@std/assert"
import { scanOggComments } from "./vorbis-scan.ts"

// Synthesizes a minimal Ogg/Opus-like stream with a vorbis comment block.
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
  // For test simplicity, we keep body short.
  const segValues: number[] = []
  let rem = body.length
  while (rem >= 255) {
    segValues.push(255)
    rem -= 255
  }
  segValues.push(rem)

  // Page header = 27 bytes; byte 26 = nsegs
  const header = new Uint8Array(27)
  header[0] = 0x4f
  header[1] = 0x67
  header[2] = 0x67
  header[3] = 0x53
  header[4] = 0
  header[5] = 0
  header[26] = segValues.length
  const segTable = new Uint8Array(segValues)
  const page = new Uint8Array(27 + segTable.length + body.length)
  page.set(header, 0)
  page.set(segTable, 27)
  page.set(body, 27 + segTable.length)

  // Prepend a synthetic OpusHead page so the scanner exercises skip logic.
  const opusHead = new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 0x01, 0x02])
  const headHeader = new Uint8Array(27)
  headHeader[0] = 0x4f
  headHeader[1] = 0x67
  headHeader[2] = 0x67
  headHeader[3] = 0x53
  headHeader[4] = 0
  headHeader[5] = 0
  headHeader[26] = 1
  const headSeg = new Uint8Array([opusHead.length])
  const headPage = new Uint8Array(27 + 1 + opusHead.length)
  headPage.set(headHeader, 0)
  headPage.set(headSeg, 27)
  headPage.set(opusHead, 28)

  return concat(headPage, page)
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length)
  r.set(a, 0)
  r.set(b, a.length)
  return r
}

Deno.test("scanOggComments skips OpusHead and parses OpusTags", () => {
  const data = buildOggWithComment("TestVendor", {
    TITLE: "Song",
    ARTIST: "Band",
    LYRICS: "line one\nline two",
  })
  const scan = scanOggComments(data)
  assertEquals(scan.vendor, "TestVendor")
  assertEquals(scan.fields["TITLE"], "Song")
  assertEquals(scan.fields["ARTIST"], "Band")
  assertEquals(scan.fields["LYRICS"], "line one\nline two")
})

Deno.test("scanOggComments returns empty for non-Ogg input", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5])
  const scan = scanOggComments(data)
  assertEquals(scan.fields, {})
  assertEquals(scan.vendor, "")
})

Deno.test("scanOggComments handles missing LYRICS", () => {
  const data = buildOggWithComment("v", { TITLE: "x" })
  const scan = scanOggComments(data)
  assertEquals(scan.fields["TITLE"], "x")
  assertEquals(scan.fields["LYRICS"], undefined)
})
