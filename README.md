# lyrics-populator

> Deno 2 CLI that scans a folder for audio files and backfills missing lyrics metadata
> automatically. Atomic writes. Resumable. Idempotent.

[![Deno 2](https://img.shields.io/badge/Deno-2.x-black?logo=deno)](https://deno.com)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![No deps beyond stdlib + 2 npm libs](https://img.shields.io/badge/dependencies-minimal-green)]()
[![LRCLib](https://img.shields.io/badge/source-LRCLib-blue)](https://lrclib.net)
[![lyrics.ovh](https://img.shields.io/badge/source-lyrics.ovh-blue)](https://lyrics.ovh)

Built to replace hours of manual Kid3 work on a personal music archive. Drop it in
a folder, run, come back later — lyrics are filled in for whatever the open web
knows about, and a JSON DB tracks progress so it can pick up exactly where it left off.

## Features

- 🎵 **Multi-format**: MP3 (ID3v2 USLT+SYLT), Opus/FLAC/OGG (Vorbis LYRICS), M4A detected
- ⚡ **Atomic writes**: copy → write → verify → rename. Original is never at risk
- 🔁 **Idempotent + resumable**: state file tracks per-file status. Safe to re-run any time
- 🚦 **Single-instance**: `flock` on `.lyrics-populator.lock` prevents double-runs
- 📦 **Manual override**: `--manual-lyrics <dir>` injects lyrics for tracks the open web doesn't have
- 🔍 **Vorbis-aware**: detects preexisting plain-text LYRICS (music-metadata doesn't)
- 🌐 **Two sources, automatic fallback**: LRCLib → lyrics.ovh
- 📝 **JSONL event log**: every state transition appended for audit
- 🔧 **Concurrent workers with rate-limit-aware jitter**: stays under LRCLib's 503 threshold

## Install

```sh
git clone https://github.com/spy4x/lyrics-populator
cd lyrics-populator

# Requires Deno 2 + ffmpeg in PATH
deno task populate --help
```

## Usage

### Quick start — scan a folder

```sh
deno task populate ~/music --concurrency 2 --delay-ms 1500
```

Sample terminal output:

```
[14:23:01] scanned 135 | populated 0 | preexisting 0 | failed 0 | skipped 0 | in-flight 2
[14:23:03] scanned 135 | populated 0 | preexisting 0 | failed 1 | skipped 0 | in-flight 2
[14:23:05] scanned 135 | populated 2 | preexisting 0 | failed 3 | skipped 2 | in-flight 2
[14:23:07] scanned 135 | populated 5 | preexisting 1 | failed 6 | skipped 4 | in-flight 2
...
[14:28:30] scanned 135 | populated 27 | preexisting 31 | failed 0 | skipped 73 | in-flight 0

state: ~/music/.lyrics-populator-state.json
log:   ~/music/.lyrics-populator.log.jsonl
```

### Dry-run a subset first

```sh
deno task populate ~/music --dry-run --limit 20 --concurrency 4 --delay-ms 500
```

Reads tags, simulates everything, no file mutation, state shows what *would* happen.

### Single file

```sh
deno task populate ~/music/artist/track.opus
```

### Force overwrite preexisting lyrics

```sh
deno task populate ~/music --force-overwrite-lyrics
```

### Inject lyrics from local file (when LRCLib/ovh don't have them)

```sh
# 1. Create lyrics files mirroring your archive structure
mkdir -p ./my-lyrics
echo "Verse 1
Line 2
Line 3" > ./my-lyrics/artist/track.opus.txt

# 2. Run populate — script reads the .txt and writes it directly
deno task populate ~/music --manual-lyrics ./my-lyrics
```

The directory structure must mirror the archive — `<manual-dir>/<relpath-from-target>.txt`.

### All flags

| Flag | Default | Notes |
| --- | --- | --- |
| `--source` | `both` | `lrclib` \| `ovh` \| `both` |
| `--concurrency` | `4` | Parallel workers |
| `--delay-ms` | `250` | Base delay between requests with ±50% jitter |
| `--dry-run` | off | Do not write tags or persist populated state |
| `--force-overwrite-lyrics` | off | Replace preexisting lyrics |
| `--keep-synced` | off | Store LRC timestamps in LYRICS (default: plain text only) |
| `--max-attempts` | `3` | Attempts before `PopulateFailed` |
| `--limit` | `0` | Process at most N files (debug) |
| `--manual-lyrics` | (none) | Use `<dir>/<relpath>.txt` as lyrics override |
| `--verbose` | off | Per-file terminal output |

## Real-world example: 135-file personal archive

```
Target: ~/sync/archive/music (124 opus + 11 mp3, mostly Russian/Ukrainian rock + YouTube rips)

Run 1 (LRCLib primary):
  Populated:    25 (Rammstein, The Prodigy, Kate Bollinger, Daft Punk, etc.)
  Preexisted:    2
  PopulateFailed: 23 (LRCLib rate-limited 503s, niche tracks)
  NoLyrics:     81 (within attempt budget, will retry)
  MissingMeta:   4

Run 2 (after rate-limit recovery):
  Populated:     2 (ANTARCTIC Флорида "Когда-то...", Сказки Чёрного Города "Зверь внутри")
  Manual:        1 (Братство Атома "Общий сбор" via --manual-lyrics)

Final: 27 tracks with real lyrics in file metadata
        98 NoLyrics (will retry on next run)
        31 Preexisted (untouched, as designed)
        4 MissingMeta (cannot match, need manual tag fix)
```

Verification via `kid3-cli -c "get LYRICS"` on a populated file:

```
$ kid3-cli -c "get LYRICS" ~/sync/archive/music/youtube-liked/Bruno\ Major/Columbo.opus
Oh Columbo, Columbo
It's time for us to say goodbye
Hold your tears and don't you cry
Columbo, Columbo
I'll see you on the other side
We'll go for a sunset ride
...
```

## State file

After each batch (every 2s or 25 entries), script writes `.lyrics-populator-state.json`:

```jsonc
{
  "version": 1,
  "createdAt": "2026-09-12T17:00:00Z",
  "updatedAt": "2026-09-12T17:05:30Z",
  "targetPath": "/home/user/music",
  "totalSeen": 135,
  "entries": {
    "artist/track.opus": {
      "relpath": "artist/track.opus",
      "absPath": "/home/user/music/artist/track.opus",
      "ext": "opus",
      "artist": "Artist",
      "title": "Title",
      "album": "Album",
      "durationSec": 213.5,
      "fileSizeBytes": 3661383,
      "sha256": "abc...",
      "status": 3,                  // LyricsStatus enum (see below)
      "attempts": 1,
      "lastAttemptAt": "...",
      "lastError": null,
      "sourcesTried": [
        { "source": "lrclib", "at": "...", "ok": true, "matchedTitle": "T", "matchedArtist": "A", "url": "..." }
      ],
      "populatedFrom": {
        "source": "lrclib",          // or "ovh" or "manual"
        "url": "https://lrclib.net/...",
        "plain": "first 200 chars...",
        "synced": false              // true if LRC timestamps available
      }
    }
  }
}
```

### `LyricsStatus` enum

| Value | Name | Meaning |
| --- | --- | --- |
| 1 | `NoLyrics` | Will be retried on next run (attempt budget not exhausted) |
| 2 | `Preexisted` | Already had non-empty lyrics tag — skipped |
| 3 | `Populated` | Script successfully wrote lyrics |
| 4 | `PopulateFailed` | Exceeded `--max-attempts` — needs manual intervention |
| 5 | `SkippedNonAudio` | Reserved |
| 6 | `DryRunWouldPopulate` | Dry-run mode, would have populated |
| 7 | `UnsupportedFormat` | Extension not handled for write (e.g. M4A) |
| 8 | `MissingMetadata` | No title tag — cannot match against any source |

## How matching works

For each file:

1. Read `artist`, `title` from tags via `music-metadata`.
2. Normalize title: strip `(feat. X)`, `(Official Video)`, `(Remix)`, etc.
   Strip artist suffixes: ` - Topic`, `VEVO`. Take first artist before `,`/`&`/`feat`.
3. **LRCLib primary**: GET `/api/get?artist_name=&track_name=&duration=`.
   If 404, fallback to `/api/search?q=` and rank by Levenshtein similarity (≥0.6).
4. **lyrics.ovh fallback** (if `--source both`): GET `/v1/{artist}/{title}`.

Instrumental tracks (LRCLib flag) are correctly skipped — no fake "lyrics" written.

## How writing works

1. Copy original → `original.tmp.PID.TS`.
2. **MP3**: `node-id3` writes USLT (plain text lyrics) and SYLT (synced LRC if available)
   in place, preserving all other ID3v2 frames.
3. **Opus/FLAC/OGG**: `ffmpeg -i <tmp> -c copy -metadata LYRICS=<text> <tmp>.out.<ext>`.
4. Re-parse modified copy with `music-metadata` + raw vorbis scanner.
5. Verify:
   - file parses,
   - lyrics present (via vorbis fallback scanner when `music-metadata` returns empty),
   - duration within ±0.5s of original,
   - size delta within bounds (allow up to 25% drop for stream-lossy muxers).
6. Atomic `Deno.rename` over original.

If any step fails: `.tmp` removed, original untouched, attempt counter increments.

## Architecture highlights

### Atomic write — why it matters

Audio files are precious. The script never modifies in place. Pattern:

```
absPath ─── copy ──→ tmpPath ─── ffmpeg writes ──→ tmpPath
   │                                                  │
   │                                                  verify
   │                                                  ├ ok ─→ rename(tmp, abs)
   │                                                  └ fail ─→ delete(tmp), keep abs
   └──────────────── untouched until verified ────────┘
```

Even mid-write crashes (OOM, kill, power loss) leave the original file intact.

### The vorbis-scanner problem

`music-metadata` is the de facto Node/Deno tag reader. But for Opus/FLAC/OGG files,
it returns empty `lyrics` array when the LYRICS field contains plain text instead of
LRC timestamp format. This means preexisting lyrics get *overwritten* on the next run.

Solution: 130-line `src/vorbis-scan.ts` parses the OggS stream + vorbis comment block
directly. Detects LYRICS presence regardless of format. Used as fallback in `readMeta`.

### Single-instance safety

```ts
const lock = new StateLock(stateRoot)
lock.acquire()  // throws if another instance holds the lock
```

Backed by `Deno.FsFile.tryLockSync(true)`. Prevents two runs clobbering each other's
state files. Tested with concurrent invocations.

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
    _set-preexisting.ts     # test helper (injects LYRICS into MP3)
  src/
    scanner.ts              # folder walk + ext allowlist
    normalize.ts            # title/artist cleanup + Levenshtein similarity
    state.ts                # JSON state DB + flock + JSONL log + sha256
    metadata.ts             # atomic read/write (MP3 via node-id3, OGG via ffmpeg)
    vorbis-scan.ts          # pure-TS OggS vorbis comment parser
    sources/
      lrclib.ts             # LRCLib API client
      ovh.ts                # lyrics.ovh client
      index.ts              # fallback chain orchestrator
    *.test.ts               # colocated unit tests
```

## Dependencies

Direct:

- `jsr:@std/path`, `@std/fs`, `@std/crypto`, `@std/async`, `@std/assert`, `@std/encoding`, `@std/cli`
- `npm:music-metadata@10.6.4` — read tags across formats
- `npm:node-id3@0.2.9` — write ID3v2 USLT/SYLT

External:

- `ffmpeg` binary — required for Opus/FLAC/OGG writes (not needed for MP3-only runs)

## Testing

```sh
deno task test    # 34 tests, includes vorbis parser, state lock, source stubs, write paths
deno task lint    # clean
deno fmt --check  # clean
```

## Known limits

- **M4A**: not written (would require re-muxing). Treated as `UnsupportedFormat`.
- **YouTube rips with mjpeg-in-opus**: ffmpeg drops incompatible streams. Audio preserved
  bit-perfectly. Size delta check tolerates up to 25% loss to accommodate this.
- **LRCLib rate-limit**: ~503s after burst. Default `--concurrency 2 --delay-ms 1500`
  stays under threshold.
- **Preexisting LRC detection**: works for both plain text and `[mm:ss.xx]` formats.
- **Single-instance**: enforced via `flock`. Concurrent invocations reject the second one.

## Recovery

| Scenario | Action |
| --- | --- |
| File got corrupted mid-write | Shouldn't happen (atomic guarantee), but `git` the audio dir to revert |
| State file corrupted | `rm .lyrics-populator-state.json` — starts fresh |
| Want to retry failed files | Just re-run. State tracks attempts, won't exceed `--max-attempts` |
| Want to retry a specific file | Edit state JSON, set `status: 1, attempts: 0` for that relpath |
| Want to override lyrics for a track | Use `--manual-lyrics <dir>` with a `<relpath>.txt` file |

## Why this exists

I had ~500 tracks in my personal archive and ~10 had lyrics because I used Kid3 to
add them manually over years. The other 490 sat there empty. Kid3 doesn't have a
"look up lyrics for 490 files and write them" feature.

This script is that feature. LRCLib covers most English/Western tracks. For Russian/
Ukrainian/niche tracks, the manual override flag lets you drop in lyrics you have
from Genius/AZLyrics/transcripts without touching code.

## License

MIT.
