import { assertEquals, assertExists } from "@std/assert"
import { ovhGet } from "./ovh.ts"

function stubFetch(handler: (url: string) => Response | Promise<Response>): void {
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch =
    ((url: string) => Promise.resolve(handler(url))) as typeof fetch
}

Deno.test("ovhGet returns null on 404", async () => {
  stubFetch(() => new Response("not found", { status: 404 }))
  const r = await ovhGet({ artist: "X", title: "Y" })
  assertEquals(r, null)
})

Deno.test("ovhGet parses lyrics from response", async () => {
  stubFetch(() =>
    new Response(
      JSON.stringify({ lyrics: "verse one\n\nchorus\n\nverse two" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )
  )
  const r = await ovhGet({ artist: "X", title: "Y" })
  assertExists(r)
  assertEquals(r!.source, "ovh")
  assertEquals(r!.synced, null)
  assertEquals(r!.plain, "verse one\n\nchorus\n\nverse two")
})

Deno.test("ovhGet returns null for empty lyrics", async () => {
  stubFetch(() => new Response(JSON.stringify({ lyrics: "   " }), { status: 200 }))
  const r = await ovhGet({ artist: "X", title: "Y" })
  assertEquals(r, null)
})
