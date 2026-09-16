import { assertEquals, assertExists } from "@std/assert"
import { coverartarchiveGetFront } from "./coverartarchive.ts"

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => Promise.resolve(handler(url))) as typeof fetch
}

Deno.test("coverartarchiveGetFront returns null on 404", async () => {
  stubFetch(() => new Response("not found", { status: 404 }))
  const r = await coverartarchiveGetFront("mbid")
  assertEquals(r, null)
})

Deno.test("coverartarchiveGetFront returns image bytes", async () => {
  let calls = 0
  stubFetch((url: string) => {
    calls++
    if (url.includes("coverartarchive.org/release/")) {
      return new Response(
        JSON.stringify({
          images: [
            {
              id: "img1",
              image: "https://example.com/cover.jpg",
              front: true,
              width: 600,
              height: 600,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }
    // Image download
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    })
  })
  const r = await coverartarchiveGetFront("release-mbid")
  assertExists(r)
  assertEquals(r!.source, "coverartarchive")
  assertEquals(r!.url, "https://example.com/cover.jpg")
  assertEquals(r!.mimeType, "image/jpeg")
  assertEquals(r!.width, 600)
  assertEquals(r!.height, 600)
  assertEquals(r!.imageBytes.length, 6)
  assertEquals(r!.imageBytes[0], 0xff)
  assertEquals(calls, 2, "expected 2 fetches (index + image)")
})

Deno.test("coverartarchiveGetFront falls back to first image when none is front", async () => {
  stubFetch((url: string) => {
    if (url.includes("coverartarchive.org/release/")) {
      return new Response(
        JSON.stringify({
          images: [
            { id: "back", image: "https://example.com/back.jpg", front: false },
            { id: "any", image: "https://example.com/any.jpg", front: false },
          ],
        }),
        { status: 200 },
      )
    }
    return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      status: 200,
      headers: { "content-type": "image/png" },
    })
  })
  const r = await coverartarchiveGetFront("mbid")
  assertExists(r)
  assertEquals(r!.url, "https://example.com/back.jpg")
  assertEquals(r!.mimeType, "image/png")
})

Deno.test("coverartarchiveGetFront returns null when index has no images", async () => {
  stubFetch(() =>
    new Response(JSON.stringify({ images: [] }), { status: 200 })
  )
  const r = await coverartarchiveGetFront("mbid")
  assertEquals(r, null)
})
