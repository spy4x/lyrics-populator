# Lyrics Populator — AGENTS.md

## Context

Deno 2 CLI that scans a folder for audio files (MP3 / FLAC / Opus / OGG / M4A) and backfills missing
metadata automatically. Phase 0 was lyrics-only; Phase 1 (merged Sep 2026, PR #2) extended to all
standard ID3v2/vorbis-comment text fields plus cover art via MusicBrainz + Cover Art Archive.

Atomic writes. Resumable. Idempotent. Single-instance via flock.

## Core Rules

- **Deno 2 only.** No Node, no npm runtime — npm packages accessed via Deno's npm: specifier only.
  This is a CLI/data tool, not a web app.
- **Minimal deps.** Stack: `music-metadata` (read tags), `node-id3` (write ID3v2), `ffmpeg` binary
  (write Opus/FLAC/OGG when ffmpeg can do it), pure-TS `vorbis-writer` (fallback for cases where
  ffmpeg's `-metadata` silently fails to overwrite). One pure-TS vorbis comment scanner in
  `src/vorbis-scan.ts` (~150 LOC) for preexisting detection (workaround for music-metadata's
  plain-text LYRICS parsing bug).
- **Atomic writes.** Always: copy → write → verify → rename. Never in-place mutation. Multi-field
  writes are part of the same atomic operation.
- **Idempotent.** State file tracks per-file, per-field status. Reruns skip done work.
- **Single-instance.** flock on `.lyrics-populator.lock` prevents double-runs.
- **External API rate limits:**
  - MusicBrainz: 1 req/sec unauthenticated. Per-source `RateLimiter` (`src/sources/rate-limiter.ts`)
    enforces even with `--concurrency 4+`. Identifying User-Agent required:
    `lyrics-populator/0.1 (github URL)`.
  - LRCLib: ~503s after burst. Default `--concurrency 2 --delay-ms 1500`.
  - Cover Art Archive: no published limit, but be polite (≤1 req/sec).
- **Money stored as ints** (Anton's convention). **Enums start at 1.**
- **2-space indent, no semis, backtick strings, 100 col** (Deno fmt defaults).
- **TS style**: `interface` for shapes, `enum` (start at 1) for finite numeric sets (e.g. legacy
  `LyricsStatus` which round-trips through JSON as integers), `type` for unions/intersections.
  String-literal union types (`"not-fetched" | "fetched" | ...`) are used for `FieldName` and
  `FieldStatus` because they serialize natively to JSON without numeric encoding and don't need a
  migration when adding new values.

## Project State

See `README.md` for usage, examples, supported formats, and recovery options.

## Workflow

1. First run `--dry-run` against a subset (`--limit N`) to gauge hit rate before committing to full
   scan.
2. Use `--concurrency 2 --delay-ms 1500` as safe defaults.
3. For tracks no source has, drop a `.txt` at `<manual-lyrics-dir>/<relpath>.txt` and pass
   `--manual-lyrics <dir>`.
4. For metadata fields, lower `--mb-confidence` if too restrictive (try 0.7).
5. After changes, run `deno task test`, `deno task lint`, `deno fmt --check`.
6. Re-run script after edits — state is preserved and idempotent.

## Naming Conventions

- `src/` — reusable modules (no CLI entrypoints)
- `src/sources/` — external API clients (one file per source)
- `scripts/` — CLI entrypoints, main orchestrator
- `*.test.ts` — colocated unit tests
- `deno.jsonc` — tasks, imports, fmt/lint config
- `.lyrics-populator-state.json` — runtime DB (gitignored)
- `.lyrics-populator.log.jsonl` — event log (gitignored)

## Key Files

| File                             | Purpose                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------- |
| `scripts/populate-lyrics.ts`     | CLI entry point                                                              |
| `src/scanner.ts`                 | Folder walk + ext allowlist                                                  |
| `src/normalize.ts`               | Title/artist cleanup + Levenshtein similarity                                |
| `src/state.ts`                   | JSON state DB + flock + JSONL log + sha256, v1→v2 migration                  |
| `src/metadata.ts`                | Atomic tag read/write (MP3 via node-id3, OGG via ffmpeg/vorbis-writer)       |
| `src/vorbis-scan.ts`             | Pure-TS OggS vorbis comment parser (read-only, preexisting detection)        |
| `src/vorbis-writer.ts`           | Pure-TS OggS vorbis comment rewriter with CRC32 (fallback when ffmpeg fails) |
| `src/sources/lrclib.ts`          | LRCLib API client (lyrics)                                                   |
| `src/sources/ovh.ts`             | lyrics.ovh API client (lyrics fallback)                                      |
| `src/sources/musicbrainz.ts`     | MusicBrainz API client (artist/album/date/trackNumber/genre)                 |
| `src/sources/coverartarchive.ts` | Cover Art Archive client (album art)                                         |
| `src/sources/rate-limiter.ts`    | Token-bucket per-source rate limiter                                         |
| `src/sources/index.ts`           | Source registry + fallback chain                                             |
| `README.md`                      | Usage, examples, format support, recovery                                    |
| `PROMPT.md`                      | Original scaffolding prompt                                                  |
| `LICENSE`                        | MIT                                                                          |

## Architecture Decisions

- **Why custom vorbis scanner (read)?** `music-metadata` returns empty `lyrics` array for plain-text
  LYRICS in vorbis comments (only parses LRC-format with syncText). Built `src/vorbis-scan.ts` to
  detect preexisting plain-text lyrics correctly so they don't get overwritten.
- **Why pure-TS OggS vorbis writer?** ffmpeg's `-metadata` flag silently fails to overwrite existing
  comment values in some cases (e.g. when the source already has the field). The
  `src/vorbis-writer.ts` module rewrites vorbis comments directly with proper CRC32 recomputation,
  guaranteeing writes land.
- **Why ffmpeg for Opus/FLAC then vorbis-writer fallback?** ffmpeg handles edge cases (YouTube-rip
  streams with mjpeg video, segment tables, large files). It works ~80% of the time. For the
  remaining 20% where it silently keeps old values, vorbis-writer kicks in. Both paths verified by
  re-parse.
- **Why `--manual-lyrics <dir>` override?** LRCLib/ovh coverage for Russian/Ukrainian/niche tracks
  is sparse. Manual override lets you inject lyrics you have (from Genius, AZLyrics, transcripts)
  without modifying source code.
- **Why plain text default?** Kid3 reads LYRICS field as-is and shows timestamps if present. Most
  players ignore `[mm:ss.xx]` prefixes. Plain text is the universal readable format. `--keep-synced`
  opts into LRC timestamps.
- **Why field matrix vs per-source flags?** MusicBrainz returns multiple fields per query. Modeling
  it as "fetch this field, try this source" lets us reuse fuzzy match infrastructure, add new
  sources per field later (AcousticBrainz for BPM/KEY, local ffmpeg astats for ReplayGain), and
  produce per-field confidence scores.

## Known Limits

- **M4A**: detected but not written (would require re-muxing; out of v1 scope).
- **Opus cover art**: not implemented (ffmpeg `-attach` fails on Opus muxers with multi-stream
  sources, native METADATA_BLOCK_PICTURE encoder pending).
- **YouTube rips with mjpeg-in-opus**: ffmpeg drops incompatible streams during `-c copy`. Audio
  preserved bit-perfectly. Size check tolerates up to 25% drop.
- **LRCLib rate-limit**: ~503s after burst. Mitigation: `--delay-ms 1500+`.
- **MusicBrainz coverage**: Russian/Ukrainian/niche tracks have low hit rate.
- **Multi-stream containers**: video stream lost on Opus/FLAC/OGG write.
- **Cover Art Archive**: only returns cover for releases with `releaseMbid`. Singles and obscure
  releases often have no cover.

## Recovery

- File corrupted mid-write? Original untouched (atomic rename guarantee). Re-run script — file's SHA
  differs from state entry, triggering re-write.
- State file corrupted? `rm .lyrics-populator-state.json` — starts fresh.
- Want to retry failed files? Re-run script — entries with `attempts < max-attempts` retry
  automatically. To reset specific entries, edit the state JSON and set
  `fields.<field>.status = "not-fetched"`, `attempts = 0`.
- Want to force-overwrite a specific field? Reset that field's status to `not-fetched`. (No global
  `--force-overwrite-metadata` flag yet — deferred.)

## Testing

```sh
deno task test    # 55 tests: vorbis parser, vorbis writer, state lock + migration,
                 # source stubs (lrclib/ovh/musicbrainz/coverartarchive),
                 # rate limiter, write paths
deno task lint    # clean
deno fmt --check  # clean
```
