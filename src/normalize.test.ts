import { assert, assertEquals } from "@std/assert"
import { normalize, normalizeArtist, normalizeTitle, similarity } from "./normalize.ts"

Deno.test("normalizeTitle strips feat./ft./featuring/with", () => {
  assertEquals(normalizeTitle("Song (feat. Someone)"), "Song")
  assertEquals(normalizeTitle("Song (ft. X)"), "Song")
  assertEquals(normalizeTitle("Song (Featuring X)"), "Song")
  assertEquals(normalizeTitle("Song (with X & Y)"), "Song")
})

Deno.test("normalizeTitle strips official markers", () => {
  assertEquals(normalizeTitle("Song (Official Video)"), "Song")
  assertEquals(normalizeTitle("Song (Official Audio)"), "Song")
  assertEquals(normalizeTitle("Song [Official Music Video]"), "Song")
  assertEquals(normalizeTitle("Song (Lyric Video)"), "Song")
})

Deno.test("normalizeTitle strips remix/edit/mix", () => {
  assertEquals(normalizeTitle("Song (Remix)"), "Song")
  assertEquals(normalizeTitle("Song (Radio Edit)"), "Song")
  assertEquals(normalizeTitle("Song (Extended Mix)"), "Song")
})

Deno.test("normalizeTitle strips quality markers", () => {
  assertEquals(normalizeTitle("Song (HD)"), "Song")
  assertEquals(normalizeTitle("Song (HQ)"), "Song")
  assertEquals(normalizeTitle("Song (4K)"), "Song")
})

Deno.test("normalizeTitle handles ' - Topic' suffix", () => {
  assertEquals(normalizeTitle("Song - Topic"), "Song")
})

Deno.test("normalizeTitle collapses whitespace", () => {
  assertEquals(normalizeTitle("  Song   Name  "), "Song Name")
})

Deno.test("normalizeArtist strips - Topic and VEVO", () => {
  assertEquals(normalizeArtist("AIDARIO - Topic"), "AIDARIO")
  assertEquals(normalizeArtist("SomeArtistVEVO"), "SomeArtistVEVO") // no trailing space
  assertEquals(normalizeArtist("SomeArtist VEVO"), "SomeArtist")
})

Deno.test("normalizeArtist takes first artist before comma/&/feat", () => {
  assertEquals(normalizeArtist("Artist1, Artist2"), "Artist1")
  assertEquals(normalizeArtist("Artist1 & Artist2"), "Artist1")
  assertEquals(normalizeArtist("Artist1 feat. Artist2"), "Artist1")
  assertEquals(normalizeArtist("Artist1 x Artist2"), "Artist1")
})

Deno.test("normalize combines both", () => {
  const r = normalize("AIDARIO - Topic", "Title (Official Video)")
  assertEquals(r.artist, "AIDARIO")
  assertEquals(r.title, "Title")
})

Deno.test("similarity basic cases", () => {
  assertEquals(similarity("hello", "hello"), 1)
  assert(similarity("hello", "world") < 0.3)
  assert(similarity("hello", "hello world") > 0.4)
  assert(similarity("Title", "Title") > 0.99)
  assert(similarity("Track Name", "Track Name") > 0.99)
})

Deno.test("handles empty/nullish inputs gracefully", () => {
  assertEquals(normalizeTitle(""), "")
  assertEquals(normalizeArtist(""), "")
  assertEquals(normalize("", "").artist, "")
  assertEquals(normalize("", "").title, "")
})
