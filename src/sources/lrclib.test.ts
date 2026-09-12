import { assertEquals, assertExists } from "@std/assert"
import { lrclibGet, lrclibSearch } from "./lrclib.ts"

// Stub fetch for deterministic tests.
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => Promise.resolve(handler(url))) as typeof fetch
}

// deno-lint-ignore no-unused-vars
function restoreFetch(): void {
  // No clean way to restore; tests should set up as needed. Caller does final restore via setFetch.
}

Deno.test("lrclibGet returns null on 404", async () => {
  stubFetch(() => new Response("not found", { status: 404 }))
  const r = await lrclibGet({ artist: "X", title: "Y" })
  assertEquals(r, null)
})

Deno.test("lrclibGet returns plain + synced when present", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify({
        id: 1,
        trackName: "Y",
        artistName: "X",
        duration: 180,
        instrumental: false,
        plainLyrics: "line1\nline2",
        syncedLyrics: "[00:00.00]line1\n[00:05.00]line2",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  )
  const r = await lrclibGet({ artist: "X", title: "Y" })
  assertExists(r)
  assertEquals(r!.source, "lrclib")
  assertEquals(r!.plain, "line1\nline2")
  assertEquals(r!.synced, "[00:00.00]line1\n[00:05.00]line2")
})

Deno.test("lrclibGet skips instrumental tracks", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify({ instrumental: true, plainLyrics: "", syncedLyrics: "" }),
      { status: 200 },
    )
  )
  const r = await lrclibGet({ artist: "X", title: "Y" })
  assertEquals(r, null)
})

Deno.test("lrclibSearch ranks by similarity and respects threshold", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify([
        { trackName: "Wrong", artistName: "Z", plainLyrics: "no", instrumental: false },
        { trackName: "Y", artistName: "X", plainLyrics: "yes", instrumental: false },
      ]),
      { status: 200 },
    )
  )
  const r = await lrclibSearch({ artist: "X", title: "Y" })
  assertExists(r)
  assertEquals(r!.matchedTitle, "Y")
})

Deno.test("lrclibSearch returns null when nothing meets threshold", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify([
        {
          trackName: "Completely Different",
          artistName: "Z",
          plainLyrics: "no",
          instrumental: false,
        },
      ]),
      { status: 200 },
    )
  )
  const r = await lrclibSearch({ artist: "X", title: "Y" })
  assertEquals(r, null)
})
