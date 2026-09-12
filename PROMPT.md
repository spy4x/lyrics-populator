# Subagent Prompt — Deno Lyrics Populator

## Goal

Single Deno 2 script (`scripts/populate-lyrics.ts`) that scans a folder (or single file) for audio
files, checks whether lyrics metadata is present, and where missing fetches lyrics from LRCLib
(primary) with lyrics.ovh as fallback, writing them into the audio file's tags safely (atomic write,
no corruption). Maintains a JSON state file in the target folder that doubles as a tiny DB so the
script is idempotent and resumable across runs.

## Stack + Conventions

- Deno 2 (no Node, no npm unless absolutely necessary).
- TS style per global AGENTS.md: no semis, 2-space indent, backtick strings, 100 col, kebab-case,
  named exports, `interface` for shapes, `enum` (start at 1) for finite sets. `interface` not `type`
  for record shapes.
- File layout in repo `lyrics-populator/`:
  - `deno.jsonc` — tasks, imports, fmt/lint config
  - `scripts/populate-lyrics.ts` — entry point
  - `src/scanner.ts` — recursive audio file discovery
  - `src/state.ts` — JSON state DB load/save + lock
  - `src/metadata.ts` — read tags, write tags (atomic)
  - `src/sources/lrclib.ts` — LRCLib client
  - `src/sources/ovh.ts` — lyrics.ovh client
  - `src/sources/index.ts` — source registry, fallback logic
  - `src/normalize.ts` — title/artist normalization
  - `src/log.ts` — JSONL append + terminal summary
  - `+lib.ts` re-exports for tests
  - colocated `*.test.ts`
- Dependencies (prefer JSR / stdlib; minimize npm):
  - `jsr:@std/path`, `jsr:@std/fs`, `jsr:@std/crypto` (SHA-256), `jsr:@std/async` (semaphore /
    pool).
  - `npm:music-metadata` for reading tags (broad format support incl. Opus/FLAC/MP3/M4A/OGG). Pin
    version.
  - `npm:node-id3` for writing ID3v2 USLT/SYLT frames to MP3.
  - For Opus/FLAC/OGG tag writing: use `npm:@flac-io/flac-tag` or `npm:music-metadata`'s write
    capability if available, otherwise shell out to `vorbiscomment` (preferred) — pick whichever
    works in a Deno subprocess with least friction. Document the choice.
- All network IO through `fetch`. No third-party HTTP clients.
- Errors: throw on missing required config, structured result objects for non-fatal operations
  (`{ ok, value, error }`).
- Tests colocated, behavior-named, deterministic.

## CLI

```
deno task populate <path> [--source lrclib|ovh|both] [--concurrency N]
                        [--delay-ms N] [--dry-run] [--force-overwrite-lyrics]
                        [--max-attempts N] [--limit N] [--verbose]
```

- `<path>`: either a folder (recursive scan) or a single audio file.
- `--source`: default `both`. `lrclib` = LRCLib-only, `ovh` = lyrics.ovh-only, `both` = LRCLib then
  ovh fallback.
- `--concurrency`: default 4.
- `--delay-ms`: base delay between requests (jitter ±50%), default 250.
- `--dry-run`: do everything except write tags or mutate state beyond marking `dryRun: true`. Still
  populate state so user can review.
- `--force-overwrite-lyrics`: when state=1 (preexisted), still fetch and overwrite. Default: leave
  preexisting lyrics alone.
- `--max-attempts`: default 3.
- `--limit N`: process only first N eligible files (debug).
- `--verbose`: per-file terminal output, otherwise summary-only.

## State JSON DB

Path: `<target-folder>/.lyrics-populator-state.json` (when target is a file, place it in the file's
parent folder).

Shape:

```ts
interface StateFile {
  version: 1
  createdAt: string // ISO
  updatedAt: string // ISO
  targetPath: string // absolute
  totalSeen: number
  entries: Record<string, /* relpath from target folder */ Entry>
}

enum LyricsStatus {
  NoLyrics = 1, // 1
  Preexisted = 2, // 2  (already had non-empty lyrics tag)
  Populated = 3, // 3  (script successfully wrote lyrics)
  PopulateFailed = 4, // 4  (max attempts exhausted)
  SkippedNonAudio = 5, // 5  (extension recognized but not audio)
  DryRunWouldPopulate = 6, // 6  (dry-run mode, would have populated)
  UnsupportedFormat = 7, // 7  (extension not handled for write)
}

interface Entry {
  relpath: string
  absPath: string
  ext: string // lowercased, no dot
  artist: string // raw from tag
  title: string // raw from tag
  album: string
  durationSec: number
  fileSizeBytes: number
  sha256: string // first run only; used for corruption guard
  status: LyricsStatus
  attempts: number
  lastAttemptAt: string | null
  lastError: string | null
  sourcesTried: Array<{
    source: "lrclib" | "ovh"
    at: string
    ok: boolean
    matchedTitle?: string
    matchedArtist?: string
    url?: string
    error?: string
  }>
  populatedFrom: {
    source: "lrclib" | "ovh"
    url: string
    plain: string // first 200 chars for sanity
    synced: boolean
  } | null
}
```

Persistence rules:

- Load existing state at start. Merge by `relpath`. Never lose entries unless `--prune` flag (out of
  scope for v1).
- Save atomically on every entry transition (write `.tmp` then `rename`). Throttle saves: batch
  every 2s OR every 25 entries, whichever first. On SIGINT, flush pending.
- Lock: `flock`-style via `Deno.openSync` + `Deno.flock` (exclusive, non-blocking) on sibling
  `.lyrics-populator.lock`. If lock held, exit with clear error message.
- Single-instance assumption (user confirmed). Lock is belt-and-braces for accidental double-runs.

## Scanner

- Recursive walk. Extensions (lowercase, with and without dot): `mp3`, `flac`, `ogg`, `opus`, `m4a`,
  `mp4` (audio-only m4a).
- Skip dotfiles, `*.tmp`, `*.bak`, anything inside `__MACOSX`, `System Volume Information`, `.git`,
  `.syncthing*`.
- For each file: compute `relpath` from target folder, stat size, compute SHA-256 once and cache in
  state entry.
- Read tags via `music-metadata.parseFile`. Extract `artist`, `title`, `album`, `duration`. If
  `title` missing, skip with status `SkippedNonAudio` (or a new status `MissingMetadata` — pick
  cleanest; suggest extending enum if needed, start at 8).
- Idempotent entry: if entry exists in state with same `sha256`, reuse it (skip read). If `sha256`
  differs, mark `dirty: true` and re-read tags.

## Lyrics Sources

### LRCLib (`https://lrclib.net`)

Endpoints (no auth):

- GET `/api/get?artist_name=...&track_name=...&duration=...` — precise match.
- GET `/api/search?q=artist+title` — fuzzy fallback.
- Response:
  `{ id, trackName, artistName, albumName, duration,
  instrumental, plainLyrics, syncedLyrics }`.

### lyrics.ovh (`https://api.lyrics.ovh`)

- GET `/v1/{artist}/{title}` — returns `{ lyrics: string }` or 404.
- Artist/title URL-encoded, slashes in artist name handled.

### Fallback chain (`--source both`)

1. LRCLib get with normalized artist/title + duration (±2s).
2. LRCLib search, take first non-instrumental result whose `trackName` similarity > 0.6 vs target
   title (Levenshtein ratio).
3. lyrics.ovh direct.
4. If all fail: bump `attempts`, record error, set status `PopulateFailed` once attempts >= max.

### Normalization (title)

Strip in this order, case-insensitive:

- `(feat. X)`, `(ft. X)`, `(featuring X)`, `(with X)`
- `(Official Video)`, `(Official Audio)`, `(Official Music Video)`
- `(Lyric Video)`, `(Lyrics)`, `(Audio)`, `(Video)`
- `(Remix)`, `(Radio Edit)`, `(Extended Mix)`, `(Extended)`, `(Club Mix)`, `(Original Mix)`
- `(HD)`, `(HQ)`, `(4K)`, `[...]` variants
- Trailing/leading whitespace and punctuation

Artist: strip `- Topic`, `VEVO`, `Official`, `Records`. Take first artist if comma/`&`/`and`/`feat.`
separated.

## Metadata Writing

### Read

Use `music-metadata` for all formats. For each file, get current lyrics fields:

- MP3: ID3v2 `USLT` (unsynced) and `SYLT` (synced) frames.
- Vorbis (Opus/FLAC/OGG): `LYRICS` field. Synced stored as LRC inside the same field (Kid3 behavior)
  or `LYRICS-<LANG>` — pick one consistent convention. Default: store synced LRC in `LYRICS`, plain
  text also in `LYRICS` plain (i.e. strip timestamps).
- M4A: iTunes `©lyr` atom.

If any non-empty lyrics present: status = `Preexisted`, skip (unless `--force-overwrite-lyrics`).

### Write (atomic, corruption-safe)

Universal pattern:

1. Copy original to `<file>.tmp.<pid>.<ts>` in same directory.
2. Apply tag write to the copy.
3. Re-parse the copy with `music-metadata`; verify:
   - file size differs only by tag overhead (sanity bound: |delta| < 64KB for ID3v2 padding, |delta|
     < 1KB for Vorbis),
   - tag values are present and parseable,
   - SHA-256 of the _audio frames_ unchanged if feasible (best-effort: for MP3 compare bytes between
     first ID3v2 header end and last ID3v1 tag start; for Vorbis compare everything outside
     `VORBIS_COMMENT` block). Document what is verified per format.
4. If verification fails: delete `.tmp`, log error, do not touch original. Increment attempts, do
   NOT mark as Populated.
5. If verification passes: `rename` the `.tmp` over original. On non-POSIX rename edge cases
   (cross-device), fall back to copy-then-delete. Use `Deno.rename`.
6. Cleanup `.tmp` on any error path.

Optional safety net: keep first-ever `.bak` per file (`<file>.bak`) alongside original before the
first successful write. Toggleable via `--keep-backup` (default off after v1 ships cleanly).

### Write per format

- MP3: `node-id3` `write` API to set USLT (plain) + SYLT (synced, with timing array parsed from
  LRC). Read existing ID3v2 first via `node-id3` `read` to preserve other frames.
- Opus/FLAC/OGG: shell out to `vorbiscomment` if available; fallback to a pure-TS writer if
  dependency friction is too high. Decision logged in code comment with rationale.
- M4A: best-effort, use `music-metadata`'s write capability if it supports it; otherwise mark
  `UnsupportedFormat` and skip with clear log message (do not corrupt file attempting unsupported
  write).

## Log File

`<target-folder>/.lyrics-populator.log.jsonl` — one JSON object per line per state transition.
Fields: `ts`, `relpath`, `event`
(`scan`|`fetch_ok`|`fetch_fail`|`write_ok`|`write_fail`|`skip`|`done`), relevant payload.
Append-only, `O_APPEND` writes, never truncate.

## Terminal Output

Default (non-verbose): single progress line with counts, updated every 2s:

```
[12:34:56] scanned 87 | populated 41 | preexisting 22 | failed 3 | in-flight 4
```

On exit: summary table with per-status counts, total time, sources hit breakdown. Exit code: 0 if no
failures, 1 if any `PopulateFailed`.

## Acceptance Tests (subagent must run)

`deno task populate <test-folder>` on a sandbox folder containing:

- 2 MP3 with no lyrics (artist + title match real songs)
- 1 MP3 with preexisting USLT (must be skipped)
- 1 Opus with no lyrics
- 1 Opus with preexisting LYRICS
- 1 file with missing title tag
- 1 unsupported (e.g. `.txt`)

Expected:

- State JSON contains 6 entries with correct statuses.
- The 2 + 1 no-lyrics files now have non-empty lyrics tags.
- The 2 preexisting files unchanged (USLT/LYRICS content byte-equal).
- Missing-title file has `SkippedNonAudio` or new `MissingMetadata` status.
- `.txt` ignored.
- `.lyrics-populator.log.jsonl` has one line per state transition.

Re-run script on same folder: idempotent — zero new fetches, zero new writes, summary shows all
eligible as `Skipped (preexisted)` or `Skipped (populated)`.

Corruption test: monkey-patch fetch to return 1MB garbage, verify file is NOT corrupted (original
sha unchanged, `.tmp` cleaned up).

Provide unit tests via `deno test` for:

- `normalize.ts` — title/artist stripping
- `state.ts` — atomic save, lock contention
- `sources/lrclib.ts` + `sources/ovh.ts` — mocked HTTP via `globalThis.fetch` stub
- `metadata.ts` atomic write — verify rollback on simulated failure

## Deliverables

1. All source files in `lyrics-populator/` per layout above.
2. `README.md` with usage, examples, known limits per format, recovery from `.bak`, dry-run
   workflow.
3. `deno.jsonc` with `tasks: { populate, test, fmt, lint }` and `imports` map.
4. `deno fmt --check` and `deno lint` clean.
5. `deno test` green.
6. Manual acceptance test run output captured in `acceptance-test-output.txt`.
7. A short commit message body and PR body (do not commit/PR — just produce the text).

## Out of Scope (v1)

- Genius source.
- iTunes Search API.
- Translation / multi-language lyrics selection.
- Web UI.
- Auto-update on file change (watch mode).
- Distributed run / parallel folders.

## Tradeoffs to Document in Code Comments

- Why `music-metadata` for read + `node-id3` for MP3 write (mature read coverage, write split for
  best per-format tooling).
- Vorbis write: `vorbiscomment` CLI vs npm package — chosen path + fallback.
- Atomic rename vs copy-then-delete: when each is used.
- LRC inside LYRICS vs separate field: convention chosen + reason.
