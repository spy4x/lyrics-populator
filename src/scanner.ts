// Audio file scanner. Recursive walk with extension allowlist.
import { join, relative, resolve } from "@std/path"

export type AudioExt = "mp3" | "flac" | "ogg" | "opus" | "m4a"

const AUDIO_EXTS = new Set<AudioExt>(["mp3", "flac", "ogg", "opus", "m4a"])

// Skip directories that should never be traversed.
const SKIP_DIRS = new Set([
  ".git",
  ".syncthing",
  ".stversions",
  "__MACOSX",
  "System Volume Information",
  "$RECYCLE.BIN",
  "node_modules",
])

export interface ScanTarget {
  kind: "folder" | "file"
  absPath: string
  relpath: string // relative to parent folder (file mode) or "" (folder mode)
}

export function resolveTarget(input: string): ScanTarget {
  const abs = resolve(input)
  try {
    const stat = Deno.statSync(abs)
    if (stat.isDirectory) {
      return { kind: "folder", absPath: abs, relpath: "" }
    }
    if (stat.isFile) {
      const ext = extOf(abs)
      if (!AUDIO_EXTS.has(ext as AudioExt)) {
        throw new Error(`not an audio file: ${abs}`)
      }
      const parent = abs.slice(0, abs.lastIndexOf("/"))
      return { kind: "file", absPath: abs, relpath: relative(parent, abs) }
    }
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      throw new Error(`path not found: ${abs}`)
    }
    throw e
  }
  throw new Error(`unsupported path: ${abs}`)
}

export function extOf(path: string): string {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return ""
  return path.slice(dot + 1).toLowerCase()
}

export interface ScannedFile {
  absPath: string
  relpath: string // relative to scan root
  ext: AudioExt
  sizeBytes: number
}

export async function* scanFolder(rootAbs: string): AsyncIterable<ScannedFile> {
  const stack: string[] = [rootAbs]
  while (stack.length) {
    const dir = stack.pop()!
    let entries: Deno.DirEntry[]
    try {
      entries = []
      for await (const e of Deno.readDir(dir)) entries.push(e)
    } catch (e) {
      // Permission denied etc. — skip, do not abort whole scan
      console.warn(`scan: skip ${dir}: ${(e as Error).message}`)
      continue
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue // dotfiles incl .lyrics-populator-state.json
      const full = join(dir, entry.name)
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue
        stack.push(full)
        continue
      }
      if (!entry.isFile) continue
      const ext = extOf(entry.name) as AudioExt
      if (!AUDIO_EXTS.has(ext)) continue
      let stat: Deno.FileInfo
      try {
        stat = Deno.statSync(full)
      } catch {
        continue
      }
      yield {
        absPath: full,
        relpath: relative(rootAbs, full),
        ext,
        sizeBytes: stat.size,
      }
    }
  }
}
