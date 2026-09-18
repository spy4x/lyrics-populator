import { assert, assertEquals, assertExists } from "@std/assert"
import { readMeta, writeLyrics } from "./metadata.ts"
import { scanOggComments } from "./vorbis-scan.ts"
import { Buffer } from "node:buffer"
import * as nodeId3 from "node-id3"

async function makeTempCopy(src: string, suffix = ".opus"): Promise<string> {
  const tmp = await Deno.makeTempFile({ suffix })
  await Deno.copyFile(src, tmp)
  return tmp
}

Deno.test("writeLyrics populates Opus file", async () => {
  // Try several sources in case one already has lyrics from a real run.
  const candidates = [
    "/home/spy4x/sync/archive/music/youtube-liked/Bruno Major/Columbo.opus",
    "/home/spy4x/sync/archive/music/youtube-liked/Handsome Dancer/Handsome Dancer - Coincidance.opus",
    "/home/spy4x/sync/archive/music/youtube-liked/Hyper - Topic/Spoiler.opus",
  ]
  let src = ""
  for (const c of candidates) {
    try {
      await Deno.stat(c)
    } catch {
      continue
    }
    const tmpTry = await Deno.makeTempFile({ suffix: ".opus" })
    try {
      await Deno.copyFile(c, tmpTry)
      const ly = scanOggComments(await Deno.readFile(tmpTry)).fields["LYRICS"]
      if (!ly) {
        src = c
        break
      }
    } finally {
      await Deno.remove(tmpTry).catch(() => {})
    }
  }
  if (!src) {
    console.log("SKIP: no candidate opus without preexisting lyrics")
    return
  }
  const tmp = await makeTempCopy(src)
  try {
    const before = scanOggComments(await Deno.readFile(tmp))
    assertEquals(before.fields["LYRICS"], undefined)
    const r = await writeLyrics(tmp, { plain: "Test lyric line one\nline two", source: "lrclib" })
    assert(r.ok, `writeLyrics failed: ${r.error}`)
    const after = scanOggComments(await Deno.readFile(tmp))
    assertExists(after.fields["LYRICS"])
    assert(after.fields["LYRICS"]!.includes("Test lyric line one"))
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
})

Deno.test("writeLyrics populates MP3 file via node-id3", async () => {
  const src = "/home/spy4x/sync/archive/music/spy4x/Code on the Road.mp3"
  try {
    await Deno.stat(src)
  } catch {
    console.log("SKIP: source mp3 not available")
    return
  }
  const tmp = await makeTempCopy(src, ".mp3")
  try {
    const r = await writeLyrics(tmp, { plain: "Test lyric line one\nline two", source: "lrclib" })
    assert(r.ok, `writeLyrics failed: ${r.error}`)
    const buf = await Deno.readFile(tmp)
    const tags = nodeId3.read(Buffer.from(buf))
    assertExists(tags?.unsynchronisedLyrics)
    assert(tags!.unsynchronisedLyrics!.text.includes("Test lyric line one"))
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
})

Deno.test("writeLyrics is atomic — failure leaves original untouched", async () => {
  // Try to write to an unsupported extension — should fail without touching file
  const tmp = await Deno.makeTempFile({ suffix: ".wav" })
  try {
    const origBytes = await Deno.readFile(tmp)
    const r = await writeLyrics(tmp, { plain: "x", source: "test" })
    assertEquals(r.ok, false)
    // Original bytes unchanged
    const afterBytes = await Deno.readFile(tmp)
    assertEquals(origBytes, afterBytes)
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
})

Deno.test("readMeta detects preexisting Opus lyrics via vorbis fallback", async () => {
  // Find a source without preexisting lyrics to avoid ffmpeg merging instead of overwriting.
  const candidates = [
    "/home/spy4x/sync/archive/music/youtube-liked/Bruno Major/Columbo.opus",
    "/home/spy4x/sync/archive/music/youtube-liked/Handsome Dancer/Handsome Dancer - Coincidance.opus",
    "/home/spy4x/sync/archive/music/youtube-liked/Hyper - Topic/Spoiler.opus",
  ]
  let src = ""
  for (const c of candidates) {
    try {
      await Deno.stat(c)
    } catch {
      continue
    }
    const tmpTry = await Deno.makeTempFile({ suffix: ".opus" })
    try {
      await Deno.copyFile(c, tmpTry)
      const ly = scanOggComments(await Deno.readFile(tmpTry)).fields["LYRICS"]
      if (!ly) {
        src = c
        break
      }
    } finally {
      await Deno.remove(tmpTry).catch(() => {})
    }
  }
  if (!src) {
    console.log("SKIP: no candidate opus without preexisting lyrics")
    return
  }
  const tmp = await makeTempCopy(src)
  try {
    // Pre-write LYRICS via ffmpeg (single-line to avoid arg-parsing pitfalls)
    const out = tmp + ".out"
    const cmd = new Deno.Command("ffmpeg", {
      args: ["-y", "-i", tmp, "-c", "copy", "-metadata", "LYRICS=preset_singleline", out + ".opus"],
      stdout: "piped",
      stderr: "piped",
    })
    const r = await cmd.output()
    if (!r.success) {
      console.log(
        "ffmpeg stderr tail:",
        new TextDecoder().decode(r.stderr).split("\n").slice(-6).join("\n"),
      )
    }
    assert(r.success, "ffmpeg preset failed")
    await Deno.remove(tmp)
    await Deno.rename(out + ".opus", tmp)
    const meta = await readMeta(tmp)
    assert(meta.hasLyrics, "should detect existing LYRICS via vorbis scan")
    assert(meta.lyricsPreview.includes("preset_singleline"))
  } finally {
    await Deno.remove(tmp).catch(() => {})
  }
})
