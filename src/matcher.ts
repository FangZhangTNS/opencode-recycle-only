// Pure command scanner for recycle-only. No OpenCode imports, so it can be
// tested in isolation.
//
// Design: a delete verb counts only when it sits in command position. Text
// inside quotes, arguments of non-shell commands, and prose such as
// `grep "rm "` never count. Segments are split on shell boundaries outside
// quotes, then each segment is walked through prefix words (sudo, xargs, do,
// if, ...) until the first real command token appears.
//
// The scanner reports a hit; it never rewrites or executes anything.

export type HitKind = "command" | "api" | "recycle-empty" | "encoded"

export interface DeleteHit {
  /** Matched verb, e.g. "rm", "remove-item", "shutil.rmtree". */
  verb: string
  kind: HitKind
  /** Command text that triggered the hit. */
  sample: string
}

interface Token {
  text: string
  quoted: boolean
}

const SEGMENT_BREAK = new Set(["\n", "\r", ";", "|", "&", "(", ")", "{", "}"])

// Words after which a command may follow. Each is skipped by skipPrefix().
const PREFIX_WORDS = new Set([
  "sudo",
  "do",
  "then",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "time",
  "command",
  "builtin",
  "exec",
  "nohup",
  "env",
  "xargs",
  "nice",
  "ionice",
  "stdbuf",
  "timeout",
  "call",
])

// Hosts whose inline argument is code that runs: shells (-c / -Command) and
// language runtimes (-c / -e / -p). A script path argument is not followed.
const INLINE_CODE_HOSTS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "python",
  "python3",
  "py",
  "node",
  "nodejs",
  "ruby",
  "perl",
  "php",
])

// Flags that consume the following token as their value.
const VALUED_FLAGS: Record<string, readonly string[]> = {
  sudo: ["-u", "-g", "-p", "-c", "-h", "-r", "-t", "-d", "-u", "-g"],
  env: ["-u", "-c", "-s"],
  xargs: ["-i", "-n", "-p", "-l", "-s", "-d", "-e", "-a"],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  stdbuf: ["-i", "-o", "-e"],
  timeout: ["-s", "-k"],
}

const COMMAND_VERBS = new Set([
  // POSIX
  "rm",
  "rmdir",
  "unlink",
  "shred",
  "srm",
  "sdelete",
  // cmd.exe
  "del",
  "erase",
  "rd",
  // PowerShell: Remove-Item and every alias it ships with
  "remove-item",
  "ri",
])

// Wiping the Recycle Bin destroys the safety net this plugin exists for.
const RECYCLE_EMPTY_VERBS = new Set(["clear-recyclebin"])

// Language/API calls that delete without a shell verb. Matched against a
// single command token, never against prose.
const API_PATTERNS: RegExp[] = [
  /^\[?[\w.]+\]?::delete(?:file|directory)?$/i,
  /^(?:file|directory)\.delete$/i,
  /^(?:deletefile|deletedirectory)$/i,
  /^(?:os|shutil|pathlib|path|p|fs|fsp|fspromises)\.(?:remove|unlink|rmdir|rmtree|rm|rmsync|unlinksync|rmdirsync|tree)$/i,
  /^[\w$.]*\.(?:unlink|rmtree|rmsync|unlinksync)$/i,
  /^(?:unlinksync|rmsync|rmdirsync)$/i,
]

// find(1) verbs that delete without a command in command position.
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"])

const MAX_DEPTH = 3

const isSpace = (c: string) => c === " " || c === "\t"

function baseName(raw: string): string {
  const bare = raw.replace(/^["']|["']$/g, "")
  const last = bare.split(/[\\/]/).pop() ?? bare
  return last.replace(/\.(?:exe|cmd|bat)$/i, "").toLowerCase()
}

function splitSegments(command: string): string[] {
  const out: string[] = []
  let start = 0
  let i = 0
  while (i < command.length) {
    const c = command[i]!
    if (c === "'") {
      i++
      while (i < command.length && command[i] !== "'") i++
      i++
      continue
    }
    if (c === '"') {
      i++
      while (i < command.length && command[i] !== '"') {
        if (command[i] === "\\") i++
        i++
      }
      i++
      continue
    }
    if (SEGMENT_BREAK.has(c)) {
      out.push(command.slice(start, i))
      i++
      start = i
      continue
    }
    i++
  }
  out.push(command.slice(start))
  return out.filter((s) => s.trim().length > 0)
}

function tokenize(segment: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < segment.length) {
    while (i < segment.length && isSpace(segment[i]!)) i++
    if (i >= segment.length) break
    let text = ""
    let quoted = false
    while (i < segment.length && !isSpace(segment[i]!)) {
      const c = segment[i]!
      if (c === "'") {
        quoted = true
        i++
        while (i < segment.length && segment[i] !== "'") {
          text += segment[i]!
          i++
        }
        i++
        continue
      }
      if (c === '"') {
        quoted = true
        i++
        while (i < segment.length && segment[i] !== '"') {
          if (segment[i] === "\\") {
            text += segment[i + 1] ?? ""
            i += 2
            continue
          }
          text += segment[i]!
          i++
        }
        i++
        continue
      }
      text += c
      i++
    }
    if (text.length > 0) tokens.push({ text, quoted })
  }
  return tokens
}

function skipPrefix(tokens: Token[], index: number): number {
  const name = baseName(tokens[index]!.text)
  const valued = new Set((VALUED_FLAGS[name] ?? []).map((f) => f.toLowerCase()))
  let j = index + 1
  if (name === "timeout") {
    // `timeout 5 cmd`: the duration is a bare token.
    while (j < tokens.length) {
      const t = tokens[j]!.text
      if (t.startsWith("-")) {
        j += valued.has(t.toLowerCase()) ? 2 : 1
        continue
      }
      return j + 1
    }
    return j
  }
  while (j < tokens.length) {
    const t = tokens[j]!.text
    if (t.startsWith("-") && t !== "-") {
      j += valued.has(t.toLowerCase()) ? 2 : 1
      continue
    }
    if (name === "cmd" && t.startsWith("/") && t.length > 1 && !t.includes("\\")) {
      j += 1
      continue
    }
    break
  }
  return j
}

// Inline code after `bash -c "..."`, `pwsh -Command "..."`, `cmd /c ...`.
function inlineCode(tokens: Token[], index: number): string | null | "encoded" {
  const flagRe = /^(?:-c|-command|\/c|-encodedcommand|-e|--eval|-p|--print)$/i
  for (let j = index + 1; j < tokens.length; j++) {
    const t = tokens[j]!.text
    if (!flagRe.test(t)) {
      // First bare token is a script path or argv; do not follow it.
      if (!t.startsWith("-") && !t.startsWith("/")) return null
      continue
    }
    if (t.toLowerCase() === "-encodedcommand") return "encoded"
    const rest = tokens
      .slice(j + 1)
      .map((x) => x.text)
      .join(" ")
    return rest.length > 0 ? rest : null
  }
  return null
}

function matchVerb(token: Token): DeleteHit | null {
  const bare = token.text.replace(/^["']|["']$/g, "")
  const name = baseName(bare)
  const verb = name.includes("::") ? name.split("::").pop()! : name
  if (RECYCLE_EMPTY_VERBS.has(verb)) {
    return { verb, kind: "recycle-empty", sample: bare }
  }
  if (COMMAND_VERBS.has(verb)) {
    return { verb, kind: "command", sample: bare }
  }
  for (const re of API_PATTERNS) {
    if (re.test(bare)) return { verb, kind: "api", sample: bare }
  }
  return null
}

function analyzeSegment(segment: string, depth: number): DeleteHit | null {
  const tokens = tokenize(segment)
  if (tokens.length === 0) return null

  // find(1): `-delete` and `-exec <cmd>` delete without a leading verb.
  if (baseName(tokens[0]!.text) === "find") {
    if (tokens.some((t) => t.text.toLowerCase() === "-delete")) {
      return { verb: "find -delete", kind: "command", sample: segment.trim() }
    }
    const execAt = tokens.findIndex((t) => FIND_EXEC.has(t.text.toLowerCase()))
    if (execAt < 0) return null
    if (depth >= MAX_DEPTH) return null
    const rest = tokens
      .slice(execAt + 1)
      .map((t) => t.text)
      .join(" ")
    return rest.length > 0 ? scanCommand(rest, depth + 1) : null
  }

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]!
    const name = baseName(token.text)

    // POSIX variable prefix: FOO=bar rm x
    if (/^[A-Za-z_][\w]*=/.test(token.text)) {
      i++
      continue
    }

    if (FIND_EXEC.has(token.text.toLowerCase())) {
      if (depth >= MAX_DEPTH) return null
      const rest = tokens
        .slice(i + 1)
        .map((t) => t.text)
        .join(" ")
      if (rest.length === 0) return null
      const hit = scanCommand(rest, depth + 1)
      if (hit) return hit
      return null
    }

    if (INLINE_CODE_HOSTS.has(name)) {
      if (depth >= MAX_DEPTH) return null
      const code = inlineCode(tokens, i)
      if (code === "encoded") {
        return { verb: "-encodedcommand", kind: "encoded", sample: token.text }
      }
      if (code) {
        const hit = scanCommand(code, depth + 1)
        if (hit) return hit
      }
      return null
    }

    if (PREFIX_WORDS.has(name)) {
      i = skipPrefix(tokens, i)
      continue
    }

    return matchVerb(token)
  }
  return null
}

function scanCommand(command: string, depth: number): DeleteHit | null {
  for (const segment of splitSegments(command)) {
    const hit = analyzeSegment(segment, depth)
    if (hit) {
      return { ...hit, sample: truncate(segment.trim() || hit.sample) }
    }
  }
  return null
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 160 ? flat.slice(0, 157) + "..." : flat
}

/**
 * Returns the first permanent-delete hit, or null when the command is safe.
 *
 * A .NET DeleteFile/DeleteDirectory call that carries SendToRecycleBin in the
 * same command is the sanctioned recycle-bin path and is not a hit.
 */
export function findBlockedDelete(command: string): DeleteHit | null {
  if (!command || command.trim().length === 0) return null
  const hit = scanCommand(command, 0)
  if (!hit) return null
  if (hit.kind === "api" && /delete(?:file|directory)$/i.test(hit.verb)) {
    if (/SendToRecycleBin/i.test(command)) return null
  }
  return hit
}
