# Lyrics Populator — AGENTS.md

## Context

Deno 2 CLI that scans a folder for audio files (MP3 / FLAC / Opus / OGG / M4A), checks if lyrics are
present in metadata, and fetches missing lyrics from LRCLib (primary) with lyrics.ovh as fallback.
Writes lyrics atomically — original file is never touched until a copy verifies clean.

Built to automate bulk lyric tagging of personal music archives. Replaces manual Kid3 work for
hundreds of tracks.

## Core Rules

- **Deno 2 only.** No Node, no npm runtime — npm packages accessed via Deno's npm: specifier only.
  This is a CLI/data tool, not a web app.
- **Minimal deps.** Stack: `music-metadata` (read tags), `node-id3` (write ID3v2), `ffmpeg` binary
  (write Opus/FLAC/OGG vorbis comments). One pure-TS vorbis comment scanner in `src/vorbis-scan.ts`
  (~150 LOC) replaces 2-3 days of OggS CRC32 work.
- **Atomic writes.** Always: copy → write → verify → rename. Never in-place mutation.
- **Idempotent.** State file tracks per-file status. Reruns skip done work.
- **Single-instance.** flock on `.lyrics-populator.lock` prevents double-runs.
- **LRCLib is rate-limited** (~503s). Default `--concurrency 2 --delay-ms 1500` stays under
  threshold. Override for fast networks.
- **Money stored as ints** (Anton's convention). **Enums start at 1.**
- **2-space indent, no semis, backtick strings, 100 col** (Deno fmt defaults).
- **TS style**: `interface` for shapes, `enum` (start at 1) for finite sets, `type` for
  unions/intersections.

## Project State

See `README.md` for usage, examples, supported formats, and recovery options.

## Workflow

1. First run `--dry-run` against a subset (`--limit N`) to gauge hit rate before committing to full
   scan.
2. Use `--concurrency 2 --delay-ms 1500` as safe defaults for LRCLib.
3. For tracks LRCLib/ovh don't have, drop a `.txt` at `<manual-lyrics-dir>/<relpath>.txt` and pass
   `--manual-lyrics <dir>`.
4. After changes, run `deno task test`, `deno task lint`, `deno fmt --check`.
5. Re-run script after edits — state is preserved and idempotent.

## Naming Conventions

- `src/` — reusable modules (no CLI entrypoints)
- `src/sources/` — external API clients (one file per source)
- `scripts/` — CLI entrypoints, main orchestrator
- `*.test.ts` — colocated unit tests
- `deno.jsonc` — tasks, imports, fmt/lint config
- `.lyrics-populator-state.json` — runtime DB (gitignored)
- `.lyrics-populator.log.jsonl` — event log (gitignored)

## Key Files

| File                         | Purpose                                                            |
| ---------------------------- | ------------------------------------------------------------------ |
| `scripts/populate-lyrics.ts` | CLI entry point                                                    |
| `src/scanner.ts`             | Folder walk + ext allowlist                                        |
| `src/normalize.ts`           | Title/artist cleanup + Levenshtein similarity                      |
| `src/state.ts`               | JSON state DB + flock + JSONL log + sha256                         |
| `src/metadata.ts`            | Atomic tag read/write (MP3 via node-id3, OGG via ffmpeg)           |
| `src/vorbis-scan.ts`         | Pure-TS OggS vorbis comment parser (workaround for music-metadata) |
| `src/sources/lrclib.ts`      | LRCLib API client                                                  |
| `src/sources/ovh.ts`         | lyrics.ovh API client                                              |
| `src/sources/index.ts`       | Fallback chain orchestrator                                        |
| `README.md`                  | Usage, examples, format support, recovery                          |
| `PROMPT.md`                  | Original prompt used to scaffold the project                       |

## Architecture Decisions

- **Why custom vorbis scanner?** `music-metadata` returns empty `lyrics` array for plain-text LYRICS
  in vorbis comments (only parses LRC-format with syncText). Built `src/vorbis-scan.ts` to detect
  preexisting plain-text lyrics correctly.
- **Why ffmpeg for Opus/FLAC writes?** Pure-TS OggS+Vorbis comment writer requires CRC32 over all
  subsequent pages on any modification — 2-3 days of work, brittle. ffmpeg handles all edge cases
  including YouTube-rip streams with mjpeg video. Tradeoff: hard dep on ffmpeg binary (not bundled).
- **Why `--manual-lyrics <dir>` override?** LRCLib coverage for Russian/Ukrainian/ niche tracks is
  sparse. Manual override lets you inject lyrics you have (e.g. from Genius, AZLyrics, or
  transcripts) without modifying the source code.
- **Why plain text default?** Kid3 reads LYRICS field as-is and shows timestamps if present. Most
  players ignore `[mm:ss.xx]` prefixes. Plain text is the universal readable format. `--keep-synced`
  flag opts into LRC timestamps.

## Known Limits

- **M4A**: detected but not written (would require re-muxing; out of v1 scope).
- **YouTube rips with mjpeg-in-opus**: ffmpeg drops incompatible streams during `-c copy`. Audio is
  preserved bit-perfectly. Size check tolerates up to 25% drop.
- **LRCLib rate-limit**: ~503s after burst. Mitigation: `--delay-ms 1500+`.
- **Multi-stream containers**: video stream lost on Opus/FLAC/OGG write.

## Recovery

- File corrupted mid-write? Original is untouched (atomic rename guarantee). Re-run script — file's
  SHA will differ from state entry, triggering re-write.
- State file corrupted? `rm .lyrics-populator-state.json` — starts fresh.
- Want to retry failed files? Re-run script — entries with `attempts < max-attempts` retry
  automatically. To reset specific entries, edit the state JSON and set `status: 1` (NoLyrics),
  `attempts: 0`.
