# lyrics-populator

> Deno 2 CLI that scans a folder for audio files and backfills missing metadata automatically:
> lyrics, artist, album, date, track number, genre, cover art. Atomic writes. Resumable. Idempotent.
> Multi-source: LRCLib + MusicBrainz + lyrics.ovh.

[![Deno 2](https://img.shields.io/badge/Deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![LRCLib](https://img.shields.io/badge/source-LRCLib-blue)](https://lrclib.net)
[![MusicBrainz](https://img.shields.io/badge/source-MusicBrainz-blue)](https://musicbrainz.org)
[![Cover Art Archive](https://img.shields.io/badge/source-Cover%20Art%20Archive-blue)](https://coverartarchive.org)
[![lyrics.ovh](https://img.shields.io/badge/source-lyrics.ovh-blue)](https://lyrics.ovh)

Built to replace hours of manual Kid3 work on a personal music archive. Drop it in a folder, run,
come back later — metadata is filled in from the open web, and a JSON DB tracks progress so it can
pick up exactly where it left off.

## Features

- 🎵 **Multi-format**: MP3 (ID3v2 USLT+SYLT+TPE1+TALB+...), Opus/FLAC/OGG (Vorbis comments + picture
  blocks)
- 🎨 **Cover art**: embedded in ID3v2 APIC (MP3) or vorbis METADATA_BLOCK_PICTURE (FLAC)
- 🏷️ **Metadata fields**: artist, title, album, albumArtist, date, trackNumber, discNumber, genre,
  composer, lyrics, coverArt — all optional via `--fields` flag
- ⚡ **Atomic writes**: copy → write → verify → rename. Original is never at risk
- 🔁 **Idempotent + resumable**: state file tracks per-field status. Safe to re-run any time
- 🚦 **Single-instance**: `flock` on `.lyrics-populator.lock` prevents double-runs
- 📦 **Manual override**: `--manual-lyrics <dir>` injects lyrics for tracks the open web doesn't
  have
- 🔍 **Vorbis-aware**: detects preexisting plain-text LYRICS via custom parser (music-metadata
  doesn't)
- 🌐 **Three sources**: MusicBrainz → LRCLib → lyrics.ovh, per field
- 📝 **JSONL event log**: every state transition appended for audit
- 🔧 **Concurrent workers with per-source rate limiting**: MusicBrainz 1 req/s, LRCLib 1 req/s,
  Cover Art Archive 1 req/s

## Install

```sh
git clone https://github.com/spy4x/lyrics-populator
cd lyrics-populator

# Requires Deno 2 + ffmpeg in PATH
deno task populate --help
```

## Usage

### Quick start — fetch all metadata

```sh
deno task populate ~/music \
  --fields "lyrics,artist,album,date,genre,coverArt" \
  --concurrency 2 --delay-ms 1500
```

### Lyrics only (legacy behavior)

```sh
deno task populate ~/music --concurrency 2 --delay-ms 1500
```

### Single file

```sh
deno task populate ~/music/artist/track.opus
```

### Dry-run first

```sh
deno task populate ~/music --dry-run --limit 20
```

### Inject lyrics from local file (when LRCLib/ovh don't have them)

```sh
mkdir -p ./my-lyrics
echo "Verse 1
Line 2" > ./my-lyrics/artist/track.opus.txt

deno task populate ~/music --manual-lyrics ./my-lyrics
```

### All flags

| Flag                       | Default  | Notes                                                             |
| -------------------------- | -------- | ----------------------------------------------------------------- |
| `--source`                 | `both`   | Lyrics source: `lrclib` \| `ovh` \| `both`                        |
| `--fields`                 | `lyrics` | Comma-separated fields: `lyrics,artist,album,date,genre,coverArt` |
| `--concurrency`            | `4`      | Parallel workers                                                  |
| `--delay-ms`               | `250`    | Base delay between requests with ±50% jitter                      |
| `--mb-confidence`          | `0.8`    | MusicBrainz match score threshold 0..1                            |
| `--no-cover-art`           | off      | Shorthand for excluding coverArt from fields                      |
| `--dry-run`                | off      | Simulate without writing tags                                     |
| `--force-overwrite-lyrics` | off      | Overwrite preexisting lyrics                                      |
| `--keep-synced`            | off      | Store LRC timestamps in LYRICS (default: plain text)              |
| `--max-attempts`           | `3`      | Attempts before `PopulateFailed`                                  |
| `--limit`                  | `0`      | Process at most N files                                           |
| `--manual-lyrics`          | (none)   | `<dir>/<relpath>.txt` as lyrics override                          |
| `--verbose`                | off      | Per-file terminal output                                          |

## State file

`.lyrics-populator-state.json` in the target folder. Version 2 with per-field tracking.

```jsonc
{
  "version": 2,
  "targetPath": "/home/user/music",
  "entries": {
    "artist/track.opus": {
      "relpath": "artist/track.opus",
      "absPath": "/home/user/music/artist/track.opus",
      "tags": {
        "artist": "Bruno Major, Dan McDougall",
        "title": "Columbo",
        "album": "Columbo",
        "albumArtist": "Bruno Major",
        "date": "2023-07-21",
        "trackNumber": null,
        "discNumber": null,
        "genre": "",
        "composer": "",
        "lyricsPreview": "Oh Columbo, Columbo..."
      },
      "durationSec": 213.5,
      "sha256": "...",
      "status": 3, // LyricsStatus (see below)
      "fields": {
        "lyrics": {
          "status": "fetched",
          "source": "lrclib",
          "url": "...",
          "matchedScore": null,
          "preview": "Oh Columbo..."
        },
        "artist": {
          "status": "fetched",
          "source": "musicbrainz",
          "url": "...",
          "matchedScore": 0.92
        },
        "album": {
          "status": "fetched",
          "source": "musicbrainz",
          "url": "...",
          "matchedScore": 0.92
        },
        "albumArtist": { "status": "fetched", "source": "musicbrainz", "matchedScore": 0.92 },
        "date": { "status": "fetched", "source": "musicbrainz", "matchedScore": 0.92 },
        "coverArt": { "status": "not-fetched" }
      },
      "populatedFrom": { // legacy lyrics-only field for backwards compat
        "source": "lrclib",
        "url": "...",
        "plain": "Oh Columbo...",
        "synced": true
      }
    }
  }
}
```

### `FieldStatus` values

| Status         | Meaning                             |
| -------------- | ----------------------------------- |
| `not-fetched`  | Never tried for this field          |
| `fetch-miss`   | Tried all sources, no result        |
| `fetched`      | Populated from a source             |
| `manual`       | User-provided via `--manual-lyrics` |
| `skipped`      | Format doesn't support this field   |
| `preexisted`   | Already present in file, left alone |
| `fetch-failed` | Network or API error (retryable)    |

### Backwards compat with v1 state files

V1 state files (`version: 1`, single `populatedFrom`) auto-migrate on load. `populatedFrom` is
preserved as a legacy field; new field data lives in `fields`.

## How matching works per source

### MusicBrainz (artist/title/album/date/trackNumber/discNumber/genre/composer/releaseMbid)

1. Read artist+title+duration from file tags
2. Normalize via `src/normalize.ts`
3. GET `https://musicbrainz.org/ws/2/recording/?query=recording:"X" AND artist:"Y"`
4. Score each hit: 0.4 × titleSim + 0.4 × artistSim + 0.2 × durationSim
5. Pick best result above `--mb-confidence` (default 0.8)
6. GET recording details → album, date, trackNumber, discNumber, genre (top tag), composer
   (relations)
7. Prefer Album releases over Single/E.P.

Rate-limited to 1 req/sec per MusicBrainz TOS. Identifying User-Agent header set per their
requirements.

### Cover Art Archive (coverArt)

1. After MusicBrainz lookup, if `releaseMbid` is returned, GET
   `https://coverartarchive.org/release/{mbid}` to find the front cover URL
2. Download the image bytes
3. Write via ID3v2 APIC frame (MP3) or ffmpeg `-attach` (FLAC)

### LRCLib (lyrics)

1. GET `https://lrclib.net/api/get?artist_name=&track_name=&duration=`
2. If 404, GET `https://lrclib.net/api/search?q=` and rank by similarity
3. Instrumental tracks (LRCLib flag) → return null (no fake lyrics written)

### lyrics.ovh (lyrics fallback)

1. GET `https://api.lyrics.ovh/v1/{artist}/{title}`
2. Returns plain text only, no LRC timestamps

## How writing works

### MP3

1. Copy original → `original.tmp.PID.TS`
2. `node-id3` reads existing ID3v2 tags
3. Apply patches for any subset of: artist, title, album, albumArtist, date, trackNumber,
   discNumber, genre, composer, lyrics (USLT+SYLT), cover art (APIC)
4. `node-id3` writes back to the copy
5. Verify (re-parse, check lyrics/cover present, duration unchanged, size delta within bounds)
6. Atomic rename

### Opus/FLAC/OGG

1. Copy original → `original.tmp.PID.TS`
2. **`src/vorbis-writer.ts`**: pure-TS OggS vorbis comment rewriter. Locates the vorbis comment
   page, decodes entries, applies overrides (replace matching keys, append new keys, preserve all
   others), repacks the page with correct segment table + OggS page CRC32. **Replaces unreliable
   ffmpeg -c copy -metadata path** (which doesn't overwrite existing values).
3. For FLAC: ffmpeg `-attach` writes cover art
4. Verify
5. Atomic rename

## Architecture highlights

### Atomic write

```
absPath ─── copy ──→ tmpPath ─── write ──→ tmpPath
   │                                       │
   │                                       verify
   │                                       ├ ok ─→ rename(tmp, abs)
   │                                       └ fail ─→ delete(tmp), keep abs
   └──────── untouched until verified ─────┘
```

Mid-write crashes (OOM, kill, power loss) leave original file intact.

### Per-source rate limiting

`src/sources/rate-limiter.ts`: token-bucket-style limiter. `acquire()` blocks until enough time has
passed since last acquire. MusicBrainz requires 1 req/sec for unauthenticated use; we enforce that
explicitly.

### Custom vorbis scanner

`src/vorbis-scan.ts`: pure-TS OggS + vorbis comment parser. Works around `music-metadata` bug where
it returns empty `lyrics` array for plain-text LYRICS in vorbis comments. Detects preexisting lyrics
before any write.

### Custom vorbis comment writer

`src/vorbis-writer.ts`: pure-TS vorbis comment rewriter. Handles the case where ffmpeg's `-metadata`
flag fails to update existing vorbis comment values. Splice in a new comment page (with new size +
segment table + CRC32) while leaving all audio pages untouched.

### Single-instance safety

`src/state.ts` `StateLock`: `Deno.FsFile.tryLockSync(true)`. Throws if another instance holds the
lock. Prevents two runs clobbering each other's state files.

## Project layout

```
lyrics-populator/
  deno.jsonc                # tasks, imports, fmt/lint config
  AGENTS.md                 # dev guidelines, architecture decisions
  README.md                 # this file
  LICENSE                   # MIT
  PROMPT.md                 # original scaffolding prompt
  scripts/
    populate-lyrics.ts      # CLI entry
    _set-preexisting.ts     # test helper
  src/
    scanner.ts              # folder walk + ext allowlist
    normalize.ts            # title/artist cleanup + Levenshtein similarity
    state.ts                # JSON state DB + flock + JSONL log + sha256
    metadata.ts             # atomic read/write (MP3 via node-id3, OGG via vorbis-writer)
    vorbis-scan.ts          # OggS vorbis comment parser (read)
    vorbis-writer.ts        # OggS vorbis comment rewriter (write)
    sources/
      lrclib.ts             # LRCLib API client
      ovh.ts                # lyrics.ovh client
      musicbrainz.ts       # MusicBrainz API client
      coverartarchive.ts   # Cover Art Archive client
      rate-limiter.ts       # per-source request rate limiting
      index.ts              # legacy fetchLyrics wrapper (lyrics chain only)
    *.test.ts               # colocated unit tests
```

## Dependencies

Direct:

- `jsr:@std/path`, `@std/fs`, `@std/crypto`, `@std/async`, `@std/assert`, `@std/encoding`,
  `@std/cli`
- `npm:music-metadata@10.6.4` — read tags across formats
- `npm:node-id3@0.2.9` — write ID3v2 (USLT, SYLT, APIC, TPE1, TALB, TDRC, ...)

External:

- `ffmpeg` binary — required for FLAC cover art attach (not needed for Opus/MP3)

## Testing

```sh
deno task test    # 55 tests, includes vorbis parser, vorbis writer, MusicBrainz, Cover Art, state migration
deno task lint    # clean
deno fmt --check  # clean
```

## Known limits

- **M4A**: detected but not written (would require re-muxing; Phase 2)
- **Opus cover art**: not written (ffmpeg `-attach` fails on multi-stream sources; would need a
  native METADATA_BLOCK_PICTURE encoder — Phase 2)
- **YouTube rips with mjpeg-in-opus**: pure-TS vorbis writer drops the video block (audio is
  preserved bit-perfectly)
- **LRCLib rate-limit**: ~503s on burst. Default `--concurrency 2 --delay-ms 1500` stays under
  threshold
- **MusicBrainz rate-limit**: 1 req/sec enforced via `RateLimiter`
- **BPM / KEY / REPLAYGAIN**: Phase 2/3 (AcousticBrainz, ffmpeg astats)

## Recovery

| Scenario                    | Action                                                       |
| --------------------------- | ------------------------------------------------------------ |
| File corrupted mid-write    | Shouldn't happen (atomic guarantee), revert from backup      |
| State file corrupted        | `rm .lyrics-populator-state.json` — starts fresh as v2       |
| Want to retry failed files  | Re-run script — entries with `attempts < max-attempts` retry |
| Want to retry specific file | Edit state JSON: `status: "not-fetched"`, `attempts: 0`      |
| v1 state file present       | Auto-migrates to v2 on load                                  |
| Want to override lyrics     | Use `--manual-lyrics <dir>`                                  |

## Attribution

MusicBrainz data is available under the [MusicBrainz Public License][mbpl]. The Cover Art Archive is
part of the MusicBrainz project. We identify this tool to MusicBrainz via the User-Agent header per
their TOS.

[mbpl]: https://musicbrainz.org/doc/MusicBrainz_License

## License

MIT.
