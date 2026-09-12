import { assert, assertEquals, assertExists } from "@std/assert"
import { join } from "@std/path"
import {
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
  assertEquals(s.version, 1)
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
