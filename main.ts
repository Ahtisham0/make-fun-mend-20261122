// mend — one patch tool for every AI edit format (SPEC.md v1).
// Applies unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls
// to a tree of text files, atomically: every file changes or none does.
// Node 22, standard library only. Written fresh for hidden-spec-cli-01-run-20261122.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch-level failure: exit 2 with exactly this one line. */
class ParseFault extends Error {
  readonly line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

/** One edit's failure: reported as `error: <code> <path>`, exit 1. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

function parseError(n: number): ParseFault {
  return new ParseFault(`error: parse ${n}`);
}

const isBlankLine = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its
 *  /-separated segments is empty, . or ... Directories are created as files need them. */
function isSafePath(p: string): boolean {
  return (
    p !== '' &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

/** A file as lines: its break (CRLF when its first line feed follows a carriage return,
 *  else LF), its lines split at that break, and whether it ends with a line break. */
interface FileModel {
  lines: string[];
  br: '\r\n' | '\n';
  finalBreak: boolean;
}

function parseFileText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

function joinFileText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read
 *  from disk on first use and cached as originals. */
class WorkTree {
  private originals = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.originals.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.originals.set(p, v);
    }
    return this.originals.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

interface MovePair {
  old: string;
  nw: string;
}

type EditFn = (tree: WorkTree, strict: boolean, moves: MovePair[]) => void;

/** Matching tiers (SPEC.md section 5): 0 exact, 1 trailing spaces/tabs stripped both sides,
 *  2 leading and trailing spaces/tabs stripped both sides. */
type Tier = 0 | 1 | 2;

function normalizeLine(s: string, tier: Tier): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where `old` occurs in `lines` at this tier; occurrences may overlap. */
function findOccurrences(lines: string[], old: string[], tier: Tier, from = 0): number[] {
  const want = old.map((l) => normalizeLine(l, tier));
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (normalizeLine(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; strict: only 0) at which `old` occurs at least once
 *  at or after `from`, with every occurrence at that tier. Null when it occurs at no tier. */
function firstTierMatch(
  lines: string[],
  old: string[],
  strict: boolean,
  from = 0,
): { tier: Tier; at: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = findOccurrences(lines, old, t, from);
    if (at.length > 0) return { tier: t, at };
  }
  return null;
}

/** One line of a replacement: a context line names its index in O (written as the file's own
 *  matched line); any other line is written as given, re-indented at tier 2. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** Build the lines that replace the matched block at `pos`: context lines come from the file,
 *  other lines are re-indented at tier 2 (F = leading whitespace of the file's first matched
 *  line, P = that of O's first line; P empty means F is prepended to every such line). */
function buildReplacement(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  nLines: NewLine[],
  tier: Tier,
): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(oldLines[0] ?? '');
  for (const nl of nLines) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]!);
    } else if (tier === 2) {
      const t = nl.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

function spliceLines(lines: string[], pos: number, oldLen: number, seg: string[]): string[] {
  return [...lines.slice(0, pos), ...seg, ...lines.slice(pos + oldLen)];
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when the value is not a valid edit. */
function jsonEditFromValue(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      tree.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const model = parseFileText(before);
      if (lineNo < 0 || lineNo > model.lines.length) throw new EditFailure('no-match', p);
      const next = spliceLines(model.lines, lineNo, 0, add);
      tree.set(p, joinFileText({ ...model, lines: next }));
    };
  }

  return null;
}

/** Read a patch as JSON: one array of edit objects, or JSON Lines with one object a line.
 *  Array-form faults name the line where the array starts; JSON Lines faults name the line. */
function readJsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw parseError(1);
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(v)) throw parseError(first + 1);
    for (const x of v) {
      const e = jsonEditFromValue(x);
      if (e === null) throw parseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlankLine(l)) return;
    let e: EditFn | null = null;
    try {
      e = jsonEditFromValue(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Format detection (SPEC.md section 4)                                */
/* ------------------------------------------------------------------ */

function detectPatchFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) =>
        l.startsWith('diff --git ') ||
        (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface UnifiedHunk {
  /** Old start line, 1-based, from `@@ -A ... @@`. */
  a: number;
  /** Context and `-` lines, in body order. */
  o: string[];
  /** Context and `+` lines: context lines name their index in `o`. */
  n: NewLine[];
  /** Whether a `\` line follows this hunk's last context or `+` line. */
  lastMarkNoBreak: boolean;
  /** Whether a `\` line follows this hunk's last `+` line (for created files). */
  lastPlusNoBreak: boolean;
}

interface UnifiedSection {
  /** Null means /dev/null (no file). */
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path named by a `--- ` / `+++ ` header line: text after the four characters, up to
 *  the first tab, surrounding spaces removed; /dev/null means no file; a leading a/ or b/
 *  is removed from either. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse one hunk starting at lines[i] (which starts with @@). Returns the hunk and the
 *  index just past its body. */
function parseUnifiedHunk(lines: string[], i: number): { hunk: UnifiedHunk; next: number } {
  const m = HUNK_HEAD.exec(lines[i]!);
  if (m === null) throw parseError(i + 1);
  const a = Number(m[1]);
  i += 1;
  interface BodyLine {
    kind: ' ' | '-' | '+' | '\\' | '';
    text: string;
  }
  const body: BodyLine[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    // The body ends at a `diff --git ` line, or at a `--- ` line followed by a `+++ ` line
    // (the next section), even though such a line starts with `-`.
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: '', text: '' });
    else if (l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      body.push({ kind: l[0] as ' ' | '-' | '+' | '\\', text: l.slice(1) });
    } else break;
    i += 1;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.kind === '') body.pop();

  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') {
      o.push(b.text);
    } else if (b.kind === '+') {
      n.push({ text: b.text, ctx: null });
    }
  }

  // A `\` line refers to the body line before it.
  let lastMarkNoBreak = false;
  let lastPlusNoBreak = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === ' ' || b.kind === '' || b.kind === '+') {
      lastMarkNoBreak = k + 1 < body.length && body[k + 1]!.kind === '\\';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    const b = body[k]!;
    if (b.kind === '+') {
      lastPlusNoBreak = k + 1 < body.length && body[k + 1]!.kind === '\\';
      break;
    }
  }
  return { hunk: { a, o, n, lastMarkNoBreak, lastPlusNoBreak }, next: i };
}

/** Parse one section starting at lines[i] (a `diff --git ` line or a `--- ` line followed by
 *  a `+++ ` line). Returns the section and the index just past it. */
function parseUnifiedSection(
  lines: string[],
  i: number,
): { section: UnifiedSection; next: number } {
  const section: UnifiedSection = {
    oldPath: null,
    newPath: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
  let diffOld: string | null = null;
  let diffNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let hasPair = false;

  if (lines[i]!.startsWith('diff --git ')) {
    const parts = lines[i]!.split(' ');
    if (parts.length !== 4 || !parts[2]!.startsWith('a/') || !parts[3]!.startsWith('b/')) {
      throw parseError(i + 1);
    }
    diffOld = parts[2]!.slice(2);
    diffNew = parts[3]!.slice(2);
    i += 1;
  }

  // Header: runs until the first hunk, the next section, or the end of the patch.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt === undefined || !nxt.startsWith('+++ ')) throw parseError(i + 2);
      if (hasPair) break; // a later pair starts a new section
      section.oldPath = headerPath(l);
      section.newPath = headerPath(nxt);
      hasPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('rename from ')) {
      renameFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      renameTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      section.isCreate = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      section.isDelete = true;
      i += 1;
      continue;
    }
    // index, old mode, new mode, similarity/dissimilarity index, Index: and any other line:
    // ignored.
    i += 1;
  }
  if (!hasPair) {
    if (renameFrom !== null) section.oldPath = renameFrom;
    else if (diffOld !== null) section.oldPath = diffOld;
    if (renameTo !== null) section.newPath = renameTo;
    else if (diffNew !== null) section.newPath = diffNew;
  }

  // Hunks of this section; prose and code fences between them are ignored.
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const r = parseUnifiedHunk(lines, i);
      section.hunks.push(r.hunk);
      i = r.next;
      continue;
    }
    i += 1;
  }
  return { section, next: i };
}

/** Apply one hunk to a file model. `d` is the sum over this section's hunks applied so far
 *  of (N's length minus O's length). Throws EditFailure('no-match', path) when O is not found. */
function applyUnifiedHunk(
  cur: FileModel,
  hunk: UnifiedHunk,
  d: number,
  strict: boolean,
  path: string,
): FileModel {
  const lines = cur.lines;
  if (hunk.o.length === 0) {
    const pos = Math.min(hunk.a + d, lines.length);
    const seg = hunk.n.map((nl) => nl.text);
    const next = spliceLines(lines, pos, 0, seg);
    let finalBreak = cur.finalBreak;
    if (pos === lines.length) finalBreak = !hunk.lastMarkNoBreak;
    return { lines: next, br: cur.br, finalBreak };
  }
  const found = firstTierMatch(lines, hunk.o, strict);
  if (found === null) throw new EditFailure('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.at[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.at) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const seg = buildReplacement(lines, best, hunk.o, hunk.n, found.tier);
  const next = spliceLines(lines, best, hunk.o.length, seg);
  let finalBreak = cur.finalBreak;
  if (best + hunk.o.length === lines.length) finalBreak = !hunk.lastMarkNoBreak;
  return { lines: next, br: cur.br, finalBreak };
}

/** Read a patch as unified diffs: every section is one edit, in order. */
function readUnifiedEdits(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      const r = parseUnifiedSection(lines, i);
      edits.push(makeUnifiedEdit(r.section));
      i = r.next;
      continue;
    }
    if (l.startsWith('@@')) throw parseError(i + 1);
    i += 1;
  }
  return edits;
}

function makeUnifiedEdit(section: UnifiedSection): EditFn {
  return (tree, strict, moves) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    const kind: 'create' | 'delete' | 'move' | 'change' =
      oldP === null || section.isCreate
        ? 'create'
        : newP === null || section.isDelete
          ? 'delete'
          : oldP !== newP
            ? 'move'
            : 'change';

    if (kind === 'create') {
      const p = newP ?? '';
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      const created: string[] = [];
      for (const h of section.hunks) {
        for (const nl of h.n) if (nl.ctx === null) created.push(nl.text);
      }
      let lastPlusNoBreak = false;
      for (let k = section.hunks.length - 1; k >= 0; k--) {
        const h = section.hunks[k]!;
        if (h.n.some((nl) => nl.ctx === null)) {
          lastPlusNoBreak = h.lastPlusNoBreak;
          break;
        }
      }
      tree.set(
        p,
        joinFileText({ lines: created, br: '\n', finalBreak: created.length > 0 && !lastPlusNoBreak }),
      );
      return;
    }

    if (kind === 'delete') {
      const p = oldP ?? '';
      if (!isSafePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) === null) throw new EditFailure('missing', p);
      tree.set(p, null);
      return;
    }

    const p = oldP ?? '';
    if (!isSafePath(p)) throw new EditFailure('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new EditFailure('missing', p);
    if (kind === 'move') {
      const np = newP ?? '';
      if (!isSafePath(np)) throw new EditFailure('unsafe', np);
      if (tree.get(np) !== null) throw new EditFailure('exists', np);
    }
    let model = parseFileText(before);
    let d = 0;
    for (const h of section.hunks) {
      model = applyUnifiedHunk(model, h, d, strict, p);
      d += h.n.length - h.o.length;
    }
    const out = joinFileText(model);
    if (kind === 'move') {
      tree.set(p, null);
      tree.set(newP!, out);
      moves.push({ old: p, nw: newP! });
    } else {
      tree.set(p, out);
    }
  };
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

/** Read a patch as SEARCH/REPLACE blocks: every block is one edit, in order. */
function readSearchReplaceEdits(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let sIdx = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        sIdx = j;
        break;
      }
    }
    if (sIdx < 0) break;

    let eqIdx = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eqIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eqIdx < 0) throw parseError(sIdx + 1);

    let endIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (endIdx < 0) throw parseError(sIdx + 1);

    // The path is the nearest line before SEARCH, after the previous block's end (or the
    // start of the patch), that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = sIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw parseError(sIdx + 1);
      path = prevPath;
    }

    const oldLines = lines.slice(sIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines));
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  return edits;
}

function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[]): EditFn {
  return (tree, strict) => {
    if (!isSafePath(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.set(
        path,
        joinFileText({ lines: newLines, br: '\n', finalBreak: newLines.length > 0 }),
      );
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFailure('missing', path);
    const model = parseFileText(before);
    const found = firstTierMatch(model.lines, oldLines, strict);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.at.length > 1) throw new EditFailure('ambiguous', path);
    const seg = buildReplacement(
      model.lines,
      found.at[0]!,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      found.tier,
    );
    const next = spliceLines(model.lines, found.at[0]!, oldLines.length, seg);
    tree.set(path, joinFileText({ ...model, lines: next }));
  };
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  /** Null means no anchor. */
  anchor: string | null;
  /** Body lines: ' ' or '' context, '-' old, '+' new. */
  body: string[];
  /** Whether a `*** End of File` line closed this chunk. */
  eof: boolean;
}

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';

function isV4aSectionStart(l: string): boolean {
  return l.startsWith(V4A_ADD) || l.startsWith(V4A_DEL) || l.startsWith(V4A_UPD);
}

/** Apply one V4A chunk. `cursor` is the 0-based line the search starts at. Returns the new
 *  model and the cursor just after the lines written. */
function applyV4aChunk(
  model: FileModel,
  chunk: V4aChunk,
  cursor: number,
  strict: boolean,
  path: string,
): { model: FileModel; cursor: number } {
  const lines = model.lines;
  let cur = cursor;

  if (chunk.anchor !== null) {
    // First line at or after the cursor equal to the anchor, at the first tier with one
    // (both sides a single line); the cursor moves past it.
    let foundAt: number | null = null;
    const tiers: Tier[] = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const want = normalizeLine(chunk.anchor, t);
      for (let j = cur; j < lines.length; j++) {
        if (normalizeLine(lines[j]!, t) === want) {
          foundAt = j;
          break;
        }
      }
      if (foundAt !== null) break;
    }
    if (foundAt === null) throw new EditFailure('no-match', path);
    cur = foundAt + 1;
  }

  const o: string[] = [];
  const n: NewLine[] = [];
  for (const bl of chunk.body) {
    if (bl === '' || bl[0] === ' ') {
      const t = bl === '' ? '' : bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: o.length - 1 });
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: null });
    }
  }

  if (o.length === 0) {
    const pos = chunk.eof ? lines.length : cur;
    const seg = n.map((nl) => nl.text);
    const next = spliceLines(lines, pos, 0, seg);
    return { model: { ...model, lines: next }, cursor: pos + seg.length };
  }

  const found = firstTierMatch(lines, o, strict, cur);
  if (found === null) throw new EditFailure('no-match', path);
  let pos = found.at[0]!;
  if (chunk.eof) {
    // An end-of-file chunk takes only an occurrence ending at the file's last line.
    const ok = found.at.filter((p) => p + o.length === lines.length);
    if (ok.length === 0) throw new EditFailure('no-match', path);
    pos = ok[0]!;
  }
  const seg = buildReplacement(lines, pos, o, n, found.tier);
  const next = spliceLines(lines, pos, o.length, seg);
  return { model: { ...model, lines: next }, cursor: pos + seg.length };
}

/** Read a patch as a V4A patch: every section is one edit, in order. */
function readV4aEdits(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlankLine(l));
  if (first < 0) throw parseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw parseError(first + 1);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!isBlankLine(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw parseError(lines.length + 1);

  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlankLine(l)) {
      i += 1;
      continue;
    }
    if (!isV4aSectionStart(l)) throw parseError(i + 1);
    const r = parseV4aSection(lines, i, last);
    edits.push(r.edit);
    i = r.next;
  }
  return edits;
}

/** Parse one V4A section starting at lines[i]. Returns the edit and the index just past it. */
function parseV4aSection(
  lines: string[],
  i: number,
  last: number,
): { edit: EditFn; next: number } {
  const head = lines[i]!;
  const startLine = i + 1;
  i += 1;

  if (head.startsWith(V4A_ADD)) {
    const path = head.slice(V4A_ADD.length).trim();
    const fileLines: string[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (isV4aSectionStart(l)) break;
      if (l.trim() === '') {
        fileLines.push('');
        i += 1;
        continue;
      }
      if (l.startsWith('+')) {
        fileLines.push(l.slice(1));
        i += 1;
        continue;
      }
      throw parseError(i + 1);
    }
    // Blank lines at the end of a section are not part of it.
    while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
    return {
      edit: (tree) => {
        if (!isSafePath(path)) throw new EditFailure('unsafe', path);
        if (tree.get(path) !== null) throw new EditFailure('exists', path);
        tree.set(
          path,
          joinFileText({ lines: fileLines, br: '\n', finalBreak: fileLines.length > 0 }),
        );
      },
      next: i,
    };
  }

  if (head.startsWith(V4A_DEL)) {
    const path = head.slice(V4A_DEL.length).trim();
    while (i < last) {
      const l = lines[i]!;
      if (isBlankLine(l)) {
        i += 1;
        continue;
      }
      if (isV4aSectionStart(l)) break;
      throw parseError(i + 1);
    }
    return {
      edit: (tree) => {
        if (!isSafePath(path)) throw new EditFailure('unsafe', path);
        if (tree.get(path) === null) throw new EditFailure('missing', path);
        tree.set(path, null);
      },
      next: i,
    };
  }

  // Update File.
  const path = head.slice(V4A_UPD.length).trim();
  let moveTo: string | null = null;
  if (i < last && lines[i]!.startsWith('*** Move to: ')) {
    moveTo = lines[i]!.slice('*** Move to: '.length).trim();
    i += 1;
  }
  const chunks: V4aChunk[] = [];
  let current: V4aChunk | null = null;
  let firstChunk = true;
  while (i < last) {
    const l = lines[i]!;
    if (isV4aSectionStart(l)) break;
    if (l === '*** End of File') {
      if (current === null) throw parseError(i + 1);
      current.eof = true;
      chunks.push(current);
      current = null;
      firstChunk = false;
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (current !== null) chunks.push(current);
      const anchor = l.slice(2).trim();
      current = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
      firstChunk = false;
      i += 1;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
      if (current === null) {
        if (!firstChunk) {
          // A blank line between chunks is ignored; any other body line after the first
          // chunk needs an @@ line.
          if (l.trim() === '') {
            i += 1;
            continue;
          }
          throw parseError(i + 1);
        }
        current = { anchor: null, body: [], eof: false };
        firstChunk = false;
      }
      current.body.push(l);
      i += 1;
      continue;
    }
    throw parseError(i + 1);
  }
  if (current !== null) chunks.push(current);
  // Blank lines at the end of a section are not part of it: a line that is empty or only
  // whitespace, at the end of the last chunk, is stripped.
  if (chunks.length > 0) {
    const lastChunk = chunks[chunks.length - 1]!;
    while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') {
      lastChunk.body.pop();
    }
  }
  if (chunks.length === 0 && moveTo === null) throw parseError(startLine);

  return {
    edit: (tree, strict, moves) => {
      if (!isSafePath(path)) throw new EditFailure('unsafe', path);
      if (moveTo !== null && !isSafePath(moveTo)) throw new EditFailure('unsafe', moveTo);
      const before = tree.get(path);
      if (before === null) throw new EditFailure('missing', path);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
      let model = parseFileText(before);
      let cursor = 0;
      for (const chunk of chunks) {
        const r = applyV4aChunk(model, chunk, cursor, strict, path);
        model = r.model;
        cursor = r.cursor;
      }
      const out = joinFileText(model);
      if (moveTo !== null) {
        tree.set(path, null);
        tree.set(moveTo, out);
        moves.push({ old: path, nw: moveTo });
      } else {
        tree.set(path, out);
      }
    },
    next: i,
  };
}

/* ------------------------------------------------------------------ */
/* Driver (SPEC.md sections 1, 2, 10)                                  */
/* ------------------------------------------------------------------ */

function readEdits(kind: string, text: string, lines: string[]): EditFn[] {
  switch (kind) {
    case 'json':
      return readJsonEdits(text, lines);
    case 'unified':
      return readUnifiedEdits(lines);
    case 'search-replace':
      return readSearchReplaceEdits(lines);
    case 'v4a':
      return readV4aEdits(lines);
    default:
      throw new ParseFault('error: format');
  }
}

/** The output rows for exit 0: one line per changed path in UTF-8 byte order; a move that
 *  succeeded replaces its pair's D and A lines with one R line sorting by <new>. */
function outputRows(tree: WorkTree, moves: MovePair[]): string[] {
  const rOld = new Map<string, string>();
  const rNew = new Map<string, string>();
  for (const m of moves) {
    if (
      tree.original(m.old) !== null &&
      tree.get(m.old) === null &&
      tree.original(m.nw) === null &&
      tree.get(m.nw) !== null
    ) {
      rOld.set(m.old, m.nw);
      rNew.set(m.nw, m.old);
    }
  }
  const entries: Array<{ key: string; line: string }> = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (rOld.has(p) || rNew.has(p)) continue;
    entries.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [old, nw] of rOld) entries.push({ key: nw, line: `R ${old} -> ${nw}` });
  entries.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  return entries.map((e) => e.line);
}

function writeTree(tree: WorkTree): void {
  for (const p of [...tree.now.keys()].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  )) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
}

function executeCli(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) {
        format = a.slice(9);
      } else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };

  const patchFile = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detectPatchFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: EditFn[];
  try {
    edits = readEdits(kind, text, lines);
    if (edits.length === 0) throw parseError(1);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }

  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  const moves: MovePair[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, strict, moves);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [
        ...fails.map((f) => `error: ${f.code} ${f.path}`),
        `failed: ${fails.length} of ${edits.length} edits`,
      ],
    };
  }
  const rows = outputRows(tree, moves);
  if (!check) writeTree(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one,
  // without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = executeCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
