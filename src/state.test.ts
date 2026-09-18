import { assert, assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import {
  defaultFields,
  defaultTagValues,
  emptyState,
  JsonlLogger,
  loadState,
  lockPathFor,
  logPathFor,
  LyricsStatus,
  parentDirOf,
  sha256OfFile,
  StateLock,
  statePathFor,
  StateSaver,
} from "./state.ts"

Deno.test("emptyState initializes defaults", () => {
  const s = emptyState("/tmp/test")
  assertEquals(s.version, 2)
  assertEquals(s.entries, {})
  assertEquals(s.totalSeen, 0)
  assertExists(s.createdAt)
})

Deno.test("loadState returns empty when file missing", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const s = loadState(tmp)
    assertEquals(s.entries, {})
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("StateSaver atomic save and reload", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const s = emptyState(tmp)
    s.entries["a.mp3"] = {
      relpath: "a.mp3",
      absPath: join(tmp, "a.mp3"),
      ext: "mp3",
      artist: "Artist",
      title: "Title",
      album: "",
      durationSec: 180,
      fileSizeBytes: 1000,
      sha256: "abc",
      status: LyricsStatus.Populated,
      attempts: 1,
      lastAttemptAt: new Date().toISOString(),
      lastError: null,
      sourcesTried: [],
      populatedFrom: { source: "lrclib", url: "https://x", plain: "p", synced: false },
      tags: defaultTagValues(),
      fields: defaultFields(),
    }
    const saver = new StateSaver(s, tmp)
    saver.markDirty()
    saver.flush()
    const reloaded = loadState(tmp)
    assertEquals(reloaded.entries["a.mp3"].status, LyricsStatus.Populated)
    assertEquals(reloaded.entries["a.mp3"].populatedFrom?.source, "lrclib")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("StateLock acquires and releases", () => {
  const tmp = Deno.makeTempDirSync()
  try {
    const l = new StateLock(tmp)
    l.acquire()
    assertExists(l)
    l.release()
  } finally {
    Deno.removeSync(tmp, { recursive: true })
  }
})

Deno.test("StateLock second acquire fails while held", () => {
  const tmp = Deno.makeTempDirSync()
  try {
    const l1 = new StateLock(tmp)
    l1.acquire()
    const l2 = new StateLock(tmp)
    let err = ""
    try {
      l2.acquire()
    } catch (e) {
      err = (e as Error).message
    }
    assert(err.includes("another instance"), `expected lock contention, got: ${err}`)
    l1.release()
    // Now l2 should succeed
    l2.acquire()
    l2.release()
  } finally {
    Deno.removeSync(tmp, { recursive: true })
  }
})

Deno.test("JsonlLogger appends lines", () => {
  const tmp = Deno.makeTempDirSync()
  try {
    const l = new JsonlLogger(tmp)
    l.append({ event: "test", value: 1 })
    l.append({ event: "test", value: 2 })
    l.close()
    const text = Deno.readTextFileSync(logPathFor(tmp))
    const lines = text.trim().split("\n")
    assertEquals(lines.length, 2)
    const obj1 = JSON.parse(lines[0])
    assertEquals(obj1.event, "test")
    assertEquals(obj1.value, 1)
    assertExists(obj1.ts)
  } finally {
    Deno.removeSync(tmp, { recursive: true })
  }
})

Deno.test("sha256OfFile matches known input", async () => {
  const tmp = await Deno.makeTempFile()
  await Deno.writeTextFile(tmp, "hello world")
  try {
    const h = await sha256OfFile(tmp)
    assertEquals(
      h,
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    )
  } finally {
    await Deno.remove(tmp)
  }
})

Deno.test("path helpers", () => {
  const tmp = "/tmp/foo/bar"
  assertEquals(parentDirOf("/tmp/foo/bar.mp3"), "/tmp/foo")
  assert(statePathFor(tmp).endsWith(".lyrics-populator-state.json"))
  assert(lockPathFor(tmp).endsWith(".lyrics-populator.lock"))
  assert(logPathFor(tmp).endsWith(".lyrics-populator.log.jsonl"))
})

Deno.test("loadState migrates v1 to v2", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const v1 = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      targetPath: tmp,
      totalSeen: 1,
      entries: {
        "track.mp3": {
          relpath: "track.mp3",
          absPath: join(tmp, "track.mp3"),
          ext: "mp3",
          artist: "Artist",
          title: "Title",
          album: "Album",
          durationSec: 180,
          fileSizeBytes: 1000,
          sha256: "abc",
          status: 3, // Populated
          attempts: 1,
          lastAttemptAt: new Date().toISOString(),
          lastError: null,
          sourcesTried: [],
          populatedFrom: {
            source: "lrclib",
            url: "https://lrclib.net/x",
            plain: "lyrics text",
            synced: false,
          },
        },
      },
    }
    const path = statePathFor(tmp)
    Deno.writeTextFileSync(path, JSON.stringify(v1))
    const loaded = loadState(tmp)
    assertEquals(loaded.version, 2)
    const e = loaded.entries["track.mp3"]
    assertEquals(e.populatedFrom?.source, "lrclib") // legacy field preserved
    assertExists(e.fields)
    assertEquals(e.fields.lyrics.status, "fetched")
    assertEquals(e.fields.lyrics.source, "lrclib")
    assertEquals(e.fields.lyrics.url, "https://lrclib.net/x")
    assertEquals(e.tags.album, "Album")
    assertEquals(e.tags.artist, "Artist")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})

Deno.test("loadState migrates v1 PopulateFailed correctly", async () => {
  const tmp = await Deno.makeTempDir()
  try {
    const v1 = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      targetPath: tmp,
      totalSeen: 1,
      entries: {
        "track.opus": {
          relpath: "track.opus",
          absPath: join(tmp, "track.opus"),
          ext: "opus",
          artist: "",
          title: "Track",
          album: "",
          durationSec: 0,
          fileSizeBytes: 1000,
          sha256: "def",
          status: 4, // PopulateFailed
          attempts: 3,
          lastAttemptAt: new Date().toISOString(),
          lastError: "no result",
          sourcesTried: [],
          populatedFrom: null,
        },
      },
    }
    Deno.writeTextFileSync(statePathFor(tmp), JSON.stringify(v1))
    const loaded = loadState(tmp)
    const e = loaded.entries["track.opus"]
    assertEquals(e.fields.lyrics.status, "fetch-failed")
    assertEquals(e.fields.lyrics.attempts, 3)
    assertEquals(e.fields.lyrics.lastError, "no result")
  } finally {
    await Deno.remove(tmp, { recursive: true })
  }
})
