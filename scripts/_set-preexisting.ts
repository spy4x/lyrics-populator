// Helper for acceptance test: inject preexisting lyrics into an MP3.
// Run: deno run -A scripts/_set-preexisting.ts <mp3path>
import * as nodeId3 from "node-id3"
import { Buffer } from "node:buffer"

const path = Deno.args[0]
if (!path) {
  console.error("usage: _set-preexisting.ts <path>")
  Deno.exit(1)
}
const buf = await Deno.readFile(path)
const tags = nodeId3.read(Buffer.from(buf)) as nodeId3.ID3v2Tag
tags.unsynchronisedLyrics = {
  language: "eng",
  shortText: "pre-existing short",
  text: "this file already had lyrics\ndo not overwrite me",
} as unknown as nodeId3.ID3v2Tag["unsynchronisedLyrics"]
const ok = nodeId3.write(tags, path)
if (!ok) {
  console.error("node-id3 write failed")
  Deno.exit(1)
}
console.log("wrote preexisting lyrics to", path)
