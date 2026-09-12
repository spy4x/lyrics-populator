// Title / artist normalization for source matching.

const TITLE_STRIP_PATTERNS: RegExp[] = [
  // common feat. variants
  /\s*\((?:feat\.?|ft\.?|featuring|with)\s+[^)]+\)/gi,
  // official tags
  /\s*\((?:official\s+(?:video|audio|music\s+video|lyric\s+video))\)/gi,
  /\s*\[(?:official\s+(?:video|audio|music\s+video|lyric\s+video))\]/gi,
  // audio/video marker
  /\s*\((?:audio|video|lyrics|lyric\s+video|visualizer|hd|hq|4k)\)/gi,
  /\s*\[(?:audio|video|lyrics|lyric\s+video|visualizer|hd|hq|4k)\]/gi,
  // remix/mix variants
  /\s*\((?:remix|radio\s+edit|extended\s+mix|extended|club\s+mix|original\s+mix|edit)\)/gi,
  /\s*\[(?:remix|radio\s+edit|extended\s+mix|extended|club\s+mix|original\s+mix|edit)\]/gi,
  // producer credit
  /\s*\((?:prod\.?\s+[^)]+)\)/gi,
  // soundtrack / album credits
  /\s*\((?:from\s+(?:the\s+)?[^)]+(?:soundtrack|ost|album)[^)]*)\)/gi,
  /\s*\[(?:from\s+(?:the\s+)?[^)]+(?:soundtrack|ost|album)[^)]*)\]/gi,
  // trailing "by <artist>"
  /\s+by\s+[\p{L}\p{N} .&'-]+$/u,
  // trailing " - Topic"
  /\s+-\s+topic$/gi,
]

const ARTIST_STRIP_PATTERNS: RegExp[] = [
  /\s+-\s+topic$/gi,
  /\s+vevo$/gi,
  /\s+official$/gi,
  /\s+records$/gi,
]

export interface Normalized {
  artist: string
  title: string
}

export function normalizeTitle(raw: string): string {
  if (!raw) return ""
  let s = raw
  for (const re of TITLE_STRIP_PATTERNS) s = s.replace(re, "")
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim()
  // strip wrapping quotes/brackets
  s = s.replace(/^[\s"'\[\(]+|[\s"'\]\)]+$/g, "")
  return s
}

export function normalizeArtist(raw: string): string {
  if (!raw) return ""
  let s = raw
  for (const re of ARTIST_STRIP_PATTERNS) s = s.replace(re, "")
  // take primary artist only
  const splitRe = /\s*(?:,|&|\bfeat\.?\b|\bft\.?\b|\bfeaturing\b|\band\b|\bx\b|\/|;)\s*/i
  const idx = s.search(splitRe)
  if (idx > 0) s = s.slice(0, idx)
  s = s.replace(/\s+/g, " ").trim()
  return s
}

export function normalize(artist: string, title: string): Normalized {
  return {
    artist: normalizeArtist(artist),
    title: normalizeTitle(title),
  }
}

// Simple Levenshtein-based similarity 0..1 for fuzzy match ranking.
export function similarity(a: string, b: string): number {
  const A = a.toLowerCase()
  const B = b.toLowerCase()
  if (!A && !B) return 1
  if (!A || !B) return 0
  const dist = levenshtein(A, B)
  const maxLen = Math.max(A.length, B.length)
  return 1 - dist / maxLen
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost,
      )
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}
