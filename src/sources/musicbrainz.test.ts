import { assertEquals, assertExists } from "@std/assert"
import { musicbrainzSearchRecording } from "./musicbrainz.ts"

// Stub fetch for deterministic tests.
function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => Promise.resolve(handler(url))) as typeof fetch
}

Deno.test("musicbrainzSearchRecording returns null on 404", async () => {
  stubFetch(() => new Response("not found", { status: 404 }))
  const r = await musicbrainzSearchRecording({ artist: "X", title: "Y" })
  assertEquals(r, null)
})

Deno.test("musicbrainzSearchRecording parses search results + detail", async () => {
  let calls = 0
  stubFetch((url: string) => {
    calls++
    if (url.includes("/recording/?query=")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: "rec-mbid-1",
              score: 100,
              title: "Real Title",
              length: 180000,
              "artist-credit": [{ name: "Real Artist", artist: { id: "a1", name: "Real Artist" } }],
              releases: [{ id: "rel-1", title: "Real Album" }],
            },
            {
              id: "rec-mbid-2",
              score: 50,
              title: "Wrong Title",
              "artist-credit": [{ name: "Z", artist: { id: "a2", name: "Z" } }],
            },
          ],
        }),
        { status: 200 },
      )
    }
    // Detail lookup
    return new Response(
      JSON.stringify({
        id: "rec-mbid-1",
        title: "Real Title",
        "artist-credit": [{ name: "Real Artist" }],
        releases: [
          {
            id: "rel-1",
            title: "Real Album",
            status: "Official",
            "release-events": [{ date: "2020-05-15" }],
            "track-list": [[{ position: 3, number: "3" }]],
            "artist-credit": [{ name: "Album Artist" }],
            "release-group": { "primary-type": "Album" },
          },
        ],
        tags: [{ name: "Rock", count: 5 }],
        relations: [{
          type: "composer",
          "target-type": "artist",
          artist: { id: "c1", name: "Composer Name" },
        }],
      }),
      { status: 200 },
    )
  })
  const r = await musicbrainzSearchRecording({
    artist: "Real Artist",
    title: "Real Title",
    durationSec: 180,
  })
  assertExists(r)
  assertEquals(r!.matchedTitle, "Real Title")
  assertEquals(r!.matchedArtist, "Real Artist")
  assertEquals(r!.recordingMbid, "rec-mbid-1")
  assertEquals(r!.fields.album, "Real Album")
  assertEquals(r!.fields.releaseMbid, "rel-1")
  assertEquals(r!.fields.albumArtist, "Album Artist")
  assertEquals(r!.fields.date, "2020-05-15")
  assertEquals(r!.fields.trackNumber, 3)
  assertEquals(r!.fields.genre, "Rock")
  assertEquals(r!.fields.composer, "Composer Name")
  assertEquals(calls, 2, "expected 2 fetch calls (search + detail)")
})

Deno.test("musicbrainzSearchRecording prefers Album over Single", async () => {
  stubFetch((url: string) => {
    if (url.includes("/recording/?query=")) {
      return new Response(
        JSON.stringify({
          recordings: [
            {
              id: "rec",
              score: 100,
              title: "Song",
              "artist-credit": [{ name: "Artist", artist: { id: "a", name: "Artist" } }],
            },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(
      JSON.stringify({
        id: "rec",
        title: "Song",
        releases: [
          { id: "single", title: "Single Release", "release-group": { "primary-type": "Single" } },
          { id: "album", title: "Album Release", "release-group": { "primary-type": "Album" } },
        ],
      }),
      { status: 200 },
    )
  })
  const r = await musicbrainzSearchRecording({ artist: "Artist", title: "Song" })
  assertExists(r)
  assertEquals(r!.fields.album, "Album Release")
  assertEquals(r!.fields.releaseMbid, "album")
})

Deno.test("musicbrainzSearchRecording returns null when no hits", async () => {
  stubFetch(() =>
    new Response(JSON.stringify({ recordings: [] }), { status: 200 })
  )
  const r = await musicbrainzSearchRecording({ artist: "X", title: "Y" })
  assertEquals(r, null)
})

Deno.test("musicbrainzSearchRecording filters by score threshold", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify({
        recordings: [
          {
            id: "low",
            score: 100,
            title: "Completely Different Track",
            "artist-credit": [{ name: "Someone Else", artist: { id: "z", name: "Someone Else" } }],
          },
        ],
      }),
      { status: 200 },
    )
  )
  const r = await musicbrainzSearchRecording({ artist: "X", title: "Y", minScore: 0.9 })
  assertEquals(r, null)
})
