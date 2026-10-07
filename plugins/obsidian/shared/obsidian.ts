// Obsidian-flavored markdown parsing and link resolution shared by the host
// worker (indexing, rename rewrites) and the frontend (navigation, rendering).

export type LinkKind = "wiki" | "markdown";

export interface ParsedLink {
  kind: LinkKind;
  embed: boolean;
  /** The note/file part, e.g. "Folder/Note" in [[Folder/Note#Heading|Alias]]. */
  target: string;
  /** Heading or block reference after "#", without the "#". */
  subpath: string | null;
  alias: string | null;
  /** Offsets of the whole link in the source text. */
  from: number;
  to: number;
  /** Offsets of `target` in the source text, for rewriting. */
  targetFrom: number;
  targetTo: number;
  /** Zero-based line number. */
  line: number;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
  offset: number;
}

export interface Frontmatter {
  raw: string;
  /** Offset just past the closing fence line. */
  end: number;
}

export const NOTE_EXTENSION = ".md";
const EXTERNAL_URL = /^[a-z][a-z0-9+.-]*:/i;
// Any indentation, so fences nested in list items count. A closing fence is the marker alone.
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;
const WIKILINK = /(!?)\[\[([^[\]\n]+?)\]\]/g;
const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\)/g;
const HEADING = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

export function isNotePath(path: string): boolean {
  return path.toLowerCase().endsWith(NOTE_EXTENSION);
}

export function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

export function stripNoteExtension(path: string): string {
  return isNotePath(path) ? path.slice(0, -NOTE_EXTENSION.length) : path;
}

export function noteTitle(path: string): string {
  return stripNoteExtension(basename(path));
}

export function extension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** Collapses "." and ".." segments; returns null when the path escapes the root. */
export function normalizePath(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

export function joinPath(...parts: string[]): string {
  return parts.filter((part) => part !== "").join("/");
}

export function parseFrontmatter(content: string): Frontmatter | null {
  if (!content.startsWith("---")) return null;
  const firstBreak = content.indexOf("\n");
  if (firstBreak === -1 || content.slice(0, firstBreak).trim() !== "---") {
    return null;
  }
  let cursor = firstBreak + 1;
  while (cursor <= content.length) {
    const next = content.indexOf("\n", cursor);
    const lineEnd = next === -1 ? content.length : next;
    const line = content.slice(cursor, lineEnd).trim();
    if (line === "---" || line === "...") {
      return {
        raw: content.slice(firstBreak + 1, cursor),
        end: next === -1 ? content.length : next + 1,
      };
    }
    if (next === -1) return null;
    cursor = next + 1;
  }
  return null;
}

interface SourceLine {
  text: string;
  offset: number;
  line: number;
  inFence: boolean;
  inFrontmatter: boolean;
}

function* sourceLines(content: string): Generator<SourceLine> {
  const frontmatter = parseFrontmatter(content);
  let fence: string | null = null;
  let offset = 0;
  let line = 0;
  for (const text of content.split("\n")) {
    const inFrontmatter = frontmatter !== null && offset < frontmatter.end;
    let inFence = fence !== null;
    if (!inFrontmatter) {
      const match: RegExpExecArray | null = (fence === null ? FENCE_OPEN : FENCE_CLOSE).exec(text);
      if (match) {
        const marker: string = match[1]!;
        if (fence === null) {
          fence = marker;
          inFence = true;
        } else if (marker[0] === fence[0] && marker.length >= fence.length) {
          fence = null;
          inFence = true;
        }
      }
    }
    yield { text, offset, line, inFence, inFrontmatter };
    offset += text.length + 1;
    line += 1;
  }
}

/** Replaces inline code spans with spaces so link regexes skip them. */
function maskInlineCode(text: string): string {
  return text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (match) =>
    " ".repeat(match.length),
  );
}

function splitSubpath(target: string): { target: string; subpath: string | null } {
  const hash = target.indexOf("#");
  if (hash === -1) return { target, subpath: null };
  return { target: target.slice(0, hash), subpath: target.slice(hash + 1) };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function parseLinks(content: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  for (const source of sourceLines(content)) {
    if (source.inFence) continue;
    const text = source.inFrontmatter ? source.text : maskInlineCode(source.text);

    for (const match of text.matchAll(WIKILINK)) {
      const embed = match[1] === "!";
      const inner = match[2]!.replace(/\\\|/g, "|");
      const pipe = inner.indexOf("|");
      const reference = pipe === -1 ? inner : inner.slice(0, pipe);
      const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
      const { target, subpath } = splitSubpath(reference);
      const start = source.offset + match.index!;
      const targetFrom = start + match[1]!.length + 2;
      links.push({
        kind: "wiki",
        embed,
        target: target.trim(),
        subpath: subpath?.trim() || null,
        alias,
        from: start,
        to: start + match[0].length,
        targetFrom,
        targetTo: targetFrom + target.length,
        line: source.line,
      });
    }

    if (source.inFrontmatter) continue;
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      let url = match[3]!.trim();
      const titleMatch = /^(\S+)\s+["'(].*["')]$/.exec(url);
      if (titleMatch) url = titleMatch[1]!;
      if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);
      if (url === "" || url.startsWith("#") || EXTERNAL_URL.test(url)) continue;
      const { target, subpath } = splitSubpath(url);
      const start = source.offset + match.index!;
      const urlOffset = match[0].indexOf("(", match[1]!.length + match[2]!.length + 2) + 1;
      const rawUrlStart = match[0].indexOf(target, urlOffset);
      const targetFrom = start + (rawUrlStart === -1 ? urlOffset : rawUrlStart);
      links.push({
        kind: "markdown",
        embed: match[1] === "!",
        target: safeDecode(target),
        subpath: subpath === null ? null : safeDecode(subpath),
        alias: match[2]! || null,
        from: start,
        to: start + match[0].length,
        targetFrom,
        targetTo: targetFrom + target.length,
        line: source.line,
      });
    }
  }
  return links;
}

export function parseHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  for (const source of sourceLines(content)) {
    if (source.inFence || source.inFrontmatter) continue;
    const match = HEADING.exec(source.text);
    if (!match) continue;
    headings.push({
      level: match[1]!.length,
      text: match[2]!.trim(),
      line: source.line,
      offset: source.offset,
    });
  }
  return headings;
}

export interface LinkResolver {
  /** Returns the vault-relative path a link points at, or null when unresolved. */
  resolve(target: string, sourcePath: string, kind?: LinkKind): string | null;
  /** The shortest wikilink target that unambiguously names `path`. */
  linkTextFor(path: string): string;
  has(path: string): boolean;
}

function pickClosest(candidates: readonly string[], sourcePath: string): string {
  if (candidates.length === 1) return candidates[0]!;
  const sourceDir = dirname(sourcePath);
  const sameDir = candidates.find((candidate) => dirname(candidate) === sourceDir);
  if (sameDir !== undefined) return sameDir;
  const ancestors = candidates
    .filter((candidate) => {
      const dir = dirname(candidate);
      return dir === "" || sourceDir.startsWith(dir + "/");
    })
    .sort((a, b) => dirname(b).length - dirname(a).length);
  if (ancestors.length > 0) return ancestors[0]!;
  return [...candidates].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  )[0]!;
}

export function createResolver(paths: Iterable<string>): LinkResolver {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const all: string[] = [];
  const addName = (key: string, path: string) => {
    const list = byName.get(key);
    if (list) list.push(path);
    else byName.set(key, [path]);
  };
  for (const path of paths) {
    all.push(path);
    const lower = path.toLowerCase();
    byPath.set(lower, path);
    addName(basename(lower), path);
    if (isNotePath(path)) addName(stripNoteExtension(basename(lower)), path);
  }

  const lookupPath = (candidate: string): string | null => {
    const lower = candidate.toLowerCase();
    return byPath.get(lower) ?? byPath.get(lower + NOTE_EXTENSION) ?? null;
  };

  const resolve = (rawTarget: string, sourcePath: string, kind: LinkKind = "wiki") => {
    const trimmed = rawTarget.trim();
    const fromRoot = trimmed.startsWith("/");
    const target = trimmed.replace(/^\/+/, "");
    if (target === "") return byPath.has(sourcePath.toLowerCase()) ? sourcePath : null;

    if (fromRoot) {
      const normalized = normalizePath(target);
      const exact = normalized === null ? null : lookupPath(normalized);
      if (exact !== null) return exact;
    }

    if (!fromRoot && (kind === "markdown" || target.startsWith("."))) {
      const relative = normalizePath(joinPath(dirname(sourcePath), target));
      const hit = relative === null ? null : lookupPath(relative);
      if (hit !== null) return hit;
    }

    if (target.includes("/")) {
      const normalized = normalizePath(target);
      if (normalized === null) return null;
      const exact = lookupPath(normalized);
      if (exact !== null) return exact;
      const lower = normalized.toLowerCase();
      const suffixMatches = all.filter((path) => {
        const candidate = path.toLowerCase();
        return (
          candidate.endsWith("/" + lower) ||
          candidate.endsWith("/" + lower + NOTE_EXTENSION)
        );
      });
      return suffixMatches.length === 0 ? null : pickClosest(suffixMatches, sourcePath);
    }

    const candidates = byName.get(target.toLowerCase());
    return candidates === undefined ? null : pickClosest(candidates, sourcePath);
  };

  return {
    resolve,
    has: (path) => byPath.has(path.toLowerCase()),
    linkTextFor(path) {
      const name = isNotePath(path) ? noteTitle(path) : basename(path);
      const sameName = byName.get(name.toLowerCase()) ?? [];
      const unique = sameName.length <= 1 || sameName.every((other) => other === path);
      return unique ? name : stripNoteExtension(path);
    },
  };
}

/** Relative markdown-link URL from one note to another, percent-encoded per segment. */
export function relativeMarkdownUrl(fromPath: string, toPath: string): string {
  const fromParts = dirname(fromPath).split("/").filter(Boolean);
  const toParts = toPath.split("/");
  let shared = 0;
  while (
    shared < fromParts.length &&
    shared < toParts.length - 1 &&
    fromParts[shared] === toParts[shared]
  ) {
    shared += 1;
  }
  const up = fromParts.slice(shared).map(() => "..");
  return [...up, ...toParts.slice(shared)].map(encodeURIComponent).join("/");
}

/**
 * Returns `content` with every link whose resolution changed rewritten to
 * point at its new location. `remap` maps old resolved paths to new ones.
 */
export function rewriteLinks(args: {
  content: string;
  oldSourcePath: string;
  newSourcePath: string;
  oldResolver: LinkResolver;
  newResolver: LinkResolver;
  remap: ReadonlyMap<string, string>;
}): string | null {
  const edits: { from: number; to: number; text: string }[] = [];
  for (const link of parseLinks(args.content)) {
    if (link.target === "") continue;
    const oldTarget = args.oldResolver.resolve(link.target, args.oldSourcePath, link.kind);
    if (oldTarget === null) continue;
    const newTarget = args.remap.get(oldTarget) ?? oldTarget;
    if (args.newResolver.resolve(link.target, args.newSourcePath, link.kind) === newTarget) {
      continue;
    }
    const text =
      link.kind === "wiki"
        ? args.newResolver.linkTextFor(newTarget)
        : relativeMarkdownUrl(args.newSourcePath, newTarget);
    edits.push({ from: link.targetFrom, to: link.targetTo, text });
  }
  if (edits.length === 0) return null;
  let result = args.content;
  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  }
  return result;
}

export function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Characters Obsidian refuses in file names. */
export const INVALID_NAME_CHARS = /[\\/:*?"<>|#^[\]]/;
