// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers, and writes every change or none. Implements SPEC.md
// version 1, the whole contract. Node 22, standard library only.
// Deterministic: no network, no wall clock, no model calls.
//
// When MAKEFUN_ENV_URL is set, this file hands over to runner.ts, which runs
// the trial's checks; otherwise it runs as the mend command line.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class ParseErr extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

// A patch's lines are its text split at \n, each with one trailing \r
// removed, and without the empty piece after a final \n (SPEC section 3).
function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// A path is safe when it is not empty, does not start with /, holds no \,
// and none of its /-separated segments is empty, . or .. (SPEC section 3).
function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// A file's text as lines plus its line break (SPEC section 3). The break is
// CRLF when the first line feed follows a carriage return, LF otherwise.
// An empty file has no lines and does not end with a line break.
type FileText = { lines: string[]; endsWithBreak: boolean; br: string };

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], endsWithBreak: false, br: '\n' };
  let br = '\n';
  const i = text.indexOf('\n');
  if (i > 0 && text[i - 1] === '\r') br = '\r\n';
  const ends = text.endsWith(br);
  const body = ends ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), endsWithBreak: ends, br };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

// ---------------------------------------------------------------------------
// Matching (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEquals(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

function findOccurrences(
  fileLines: string[],
  oldLines: string[],
  tier: number,
  from: number,
  mustEndAtLast: boolean,
): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  const lastStart = fileLines.length - oldLines.length;
  for (let i = from; i <= lastStart; i++) {
    if (mustEndAtLast && i !== lastStart) continue;
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!lineEquals(fileLines[i + j], oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 with --strict) at which the old
// lines occur at least once, with every occurrence at that tier.
function findTier(
  fileLines: string[],
  oldLines: string[],
  strict: boolean,
  from: number,
  mustEndAtLast: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = findOccurrences(fileLines, oldLines, t, from, mustEndAtLast);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

// One new line of an edit: either a context line (written as the file's own
// matched line, at the index of that context line inside O) or an added
// line (written as the patch wrote it, re-indented at tier 2).
type NewLine = { text: string; ctx: number | null };

function buildNewLines(
  fileLines: string[],
  pos: number,
  oldLines: string[],
  newLines: NewLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const reindent = tier === 2 && oldLines.length > 0;
  const f = reindent ? leadingWS(fileLines[pos]) : '';
  const p = reindent ? leadingWS(oldLines[0]) : '';
  for (const item of newLines) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx]);
      continue;
    }
    const t = item.text;
    if (reindent && t !== '' && t.trim() !== '' && t.startsWith(p)) {
      out.push(f + t.slice(p.length));
    } else {
      out.push(t);
    }
  }
  return out;
}

// Count overlapping occurrences of a needle in a haystack (SPEC section 9).
function countOccurrences(hay: string, needle: string): number {
  let count = 0;
  let idx = 0;
  for (;;) {
    const p = hay.indexOf(needle, idx);
    if (p === -1) return count;
    count += 1;
    idx = p + 1;
  }
}

// ---------------------------------------------------------------------------
// The tree: the working directory as the edits leave it.
// ---------------------------------------------------------------------------

type OrigInfo = { kind: 'file' | 'dir' | 'absent'; text: string };

class Tree {
  // Current contents of every path an edit touched: text, or null when the
  // path was deleted. Paths never touched keep their on-disk state.
  private state = new Map<string, string | null>();
  // What each touched path was before the patch.
  private orig = new Map<string, OrigInfo>();
  // Paths known to be directories in the current model.
  private dirs = new Set<string>();

  private snapshot(p: string): OrigInfo {
    const known = this.orig.get(p);
    if (known) return known;
    let info: OrigInfo = { kind: 'absent', text: '' };
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        info = { kind: 'dir', text: '' };
        this.dirs.add(p);
      } else if (st.isFile()) {
        info = { kind: 'file', text: readFileSync(p, 'utf8') };
      } else {
        info = { kind: 'file', text: readFileSync(p, 'utf8') };
      }
    } catch {
      info = { kind: 'absent', text: '' };
    }
    this.orig.set(p, info);
    return info;
  }

  // Does the path exist, as a file, as a directory, or not at all? A path
  // that exists as a directory exists (SPEC section 2, `exists`).
  existsAs(p: string): 'file' | 'dir' | 'absent' {
    if (this.dirs.has(p)) return 'dir';
    if (this.state.has(p)) return this.state.get(p) === null ? 'absent' : 'file';
    const info = this.snapshot(p);
    if (info.kind === 'absent') return 'absent';
    return info.kind;
  }

  // The file's current text, or null when it is absent or a directory.
  read(p: string): string | null {
    if (this.state.has(p)) return this.state.get(p);
    const info = this.snapshot(p);
    if (info.kind !== 'file') return null;
    this.state.set(p, info.text);
    return info.text;
  }

  // Record a write. Directories are created as files need them (SPEC
  // section 3): every ancestor of a written file becomes a directory.
  write(p: string, text: string): void {
    this.snapshot(p);
    this.state.set(p, text);
    this.dirs.delete(p);
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) {
      this.dirs.add(parts.slice(0, k).join('/'));
    }
  }

  delete(p: string): void {
    this.snapshot(p);
    this.state.set(p, null);
    this.dirs.delete(p);
  }

  // The nearest ancestor of p that is a file in the current model, or null.
  // A file cannot be created under a file. `ignore` names a path that is
  // about to be deleted by the same edit, so it does not count.
  ancestorFile(p: string, ignore?: string): string | null {
    const parts = p.split('/');
    for (let k = 1; k < parts.length; k++) {
      const a = parts.slice(0, k).join('/');
      if (ignore !== undefined && a === ignore) continue;
      if (this.existsAs(a) === 'file') return a;
    }
    return null;
  }

  paths(): string[] {
    return [...this.state.keys()];
  }

  origOf(p: string): OrigInfo {
    return this.snapshot(p);
  }

  afterOf(p: string): string | null {
    if (this.state.has(p)) return this.state.get(p);
    const info = this.snapshot(p);
    return info.kind === 'file' ? info.text : null;
  }

  // Write every change to disk: deletions first, then writes, so a file can
  // take the place of a deleted file and a file can be created where a
  // deleted file's directory now stands.
  flush(): void {
    for (const [p, v] of this.state) {
      if (v === null) {
        const o = this.orig.get(p);
        if (o && o.kind === 'file') rmSync(p, { force: true });
      }
    }
    for (const [p, v] of this.state) {
      if (v !== null) {
        const o = this.orig.get(p);
        if (o && o.kind === 'file' && o.text === v) continue;
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v, 'utf8');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Edits: one parsed edit per section, block or object (SPEC section 10).
// ---------------------------------------------------------------------------

type BodyItem = { kind: 'ctx' | 'old' | 'add'; text: string; raw: string; mark: boolean };

type Hunk = { a: number; body: BodyItem[] };

type VChunk = { anchor: string | null; eof: boolean; body: BodyItem[] };

type Edit =
  | { format: 'unified'; kind: 'create' | 'delete' | 'move' | 'change'; oldPath: string | null; newPath: string | null; hunks: Hunk[] }
  | { format: 'sr'; kind: 'create' | 'change'; path: string; oldLines: string[]; newLines: string[] }
  | { format: 'v4a'; kind: 'add' | 'delete' | 'update'; path: string; moveTo: string | null; lines: string[]; chunks: VChunk[] }
  | { format: 'json'; kind: 'create'; path: string; text: string }
  | { format: 'json'; kind: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { format: 'json'; kind: 'insert'; path: string; line: number; text: string };

// A hunk's old lines O and new lines N, in body order. Context lines are in
// both, with the index of that context line inside O.
function hunkON(hunk: Hunk | VChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const item of hunk.body) {
    if (item.kind === 'ctx') {
      o.push(item.text);
      n.push({ text: item.text, ctx: o.length - 1 });
    } else if (item.kind === 'old') {
      o.push(item.text);
    } else {
      n.push({ text: item.text, ctx: null });
    }
  }
  return { o, n };
}

// Whether a \ line follows the hunk's last context or + line (SPEC
// section 6). A \ line refers to the body line before it.
function hunkNoEol(body: BodyItem[]): boolean {
  for (let k = body.length - 1; k >= 0; k--) {
    const it = body[k];
    if (it.kind === 'ctx' || it.kind === 'add') return it.mark;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC section 4)
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) return null;
  const firstLine = lines[first];
  if (firstLine.trim() === '*** Begin Patch') return 'v4a';
  const t = firstLine.replace(/^\s+/, '');
  if (t.startsWith('[') || t.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.replace(/\s+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

// The path of a --- or +++ line: the text after the four characters, up to
// the first tab, with surrounding spaces removed; /dev/null means no file;
// a leading a/ or b/ is removed from either.
function diffPath(raw: string): string | null {
  const t = raw.split('\t')[0].trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/')) return t.slice(2);
  if (t.startsWith('b/')) return t.slice(2);
  return t;
}

type UniSection = {
  diffOld: string | undefined;
  diffNew: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameOld: string | undefined;
  renameNew: string | undefined;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
};

function parseHunkBody(lines: string[], start: number): { body: BodyItem[]; next: number } {
  const body: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    // The body ends at a diff --git line, or at a --- line followed by a
    // +++ line.
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
    if (line === '') {
      body.push({ kind: 'ctx', text: '', raw: '', mark: false });
      i += 1;
      continue;
    }
    const c = line[0];
    if (c === ' ') {
      body.push({ kind: 'ctx', text: line.slice(1), raw: line, mark: false });
      i += 1;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: line.slice(1), raw: line, mark: false });
      i += 1;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'add', text: line.slice(1), raw: line, mark: false });
      i += 1;
      continue;
    }
    if (c === '\\') {
      // A \ line refers to the body line before it.
      if (body.length > 0) body[body.length - 1].mark = true;
      i += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it. Only zero-length
  // lines are empty: a ` ` line is a context line whose text is empty, and
  // it stays (SPEC sections 3 and 6 use "empty" and "blank" distinctly).
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'ctx' && last.raw === '') body.pop();
    else break;
  }
  return { body, next: i };
}

function parseUnified(lines: string[]): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new ParseErr(i + 1);
      cur = {
        diffOld: m[1],
        diffNew: m[2],
        pairOld: undefined,
        pairNew: undefined,
        renameOld: undefined,
        renameNew: undefined,
        createFlag: false,
        deleteFlag: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (cur && inHeader) {
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1].slice(4));
      } else {
        cur = {
          diffOld: undefined,
          diffNew: undefined,
          pairOld: diffPath(line.slice(4)),
          pairNew: diffPath(lines[i + 1].slice(4)),
          renameOld: undefined,
          renameNew: undefined,
          createFlag: false,
          deleteFlag: false,
          hunks: [],
        };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m || !cur) throw new ParseErr(i + 1);
      const parsed = parseHunkBody(lines, i + 1);
      cur.hunks.push({ a: parseInt(m[1], 10), body: parsed.body });
      i = parsed.next;
      inHeader = false;
      continue;
    }
    if (cur && inHeader) {
      if (line.startsWith('--- ')) {
        // A --- line not followed by a +++ line, inside a section's header.
        throw new ParseErr(i + 2);
      }
      if (line.startsWith('+++ ')) {
        cur.pairNew = diffPath(line.slice(4));
        i += 1;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.renameOld = line.slice(12).trim();
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.renameNew = line.slice(10).trim();
        i += 1;
        continue;
      }
      if (line === 'new file mode' || line.startsWith('new file mode ')) {
        cur.createFlag = true;
        i += 1;
        continue;
      }
      if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        cur.deleteFlag = true;
        i += 1;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index,
      // Index: lines, and any other line, are ignored.
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }
  if (sections.length === 0) throw new ParseErr(1);
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.diffOld !== undefined ? s.diffOld : null;
    const newPath = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.diffNew !== undefined ? s.diffNew : null;
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (oldPath === null || s.createFlag) kind = 'create';
    else if (newPath === null || s.deleteFlag) kind = 'delete';
    else if (oldPath !== newPath) kind = 'move';
    else kind = 'change';
    edits.push({ format: 'unified', kind, oldPath, newPath, hunks: s.hunks });
  }
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  const isSearch = (l: string): boolean => l.replace(/\s+$/, '') === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.replace(/\s+$/, '') === '=======';
  const isReplace = (l: string): boolean => l.replace(/\s+$/, '') === '>>>>>>> REPLACE';
  while (i < lines.length) {
    if (!isSearch(lines[i])) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line, that is not blank and does not start
    // with three backticks. When there is no such line the block takes the
    // previous block's path.
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseErr(searchLine);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isSep(lines[j])) {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new ParseErr(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (isReplace(lines[j])) {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseErr(searchLine);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push({
      format: 'sr',
      kind: oldLines.length === 0 ? 'create' : 'change',
      path,
      oldLines,
      newLines,
    });
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (!isBlank(lines[k])) {
      first = k;
      break;
    }
  }
  if (first === -1) throw new ParseErr(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseErr(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseErr(lines.length + 1);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    // Blank lines between sections are ignored.
    while (i < last && isBlank(lines[i])) i += 1;
    if (i >= last) break;
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new ParseErr(i + 1);
    }
    const headerLine = i + 1;
    // The section's lines run to the next section or *** End Patch.
    let j = i + 1;
    while (j < last && !isSectionStart(lines[j])) j += 1;
    // Blank lines at the end of a section are not part of it. A blank line
    // at the end of a chunk, before the next @@, is not at the end of the
    // section, so it stays in the chunk.
    const span: { text: string; no: number }[] = [];
    for (let k = i + 1; k < j; k++) span.push({ text: lines[k], no: k + 1 });
    while (span.length > 0 && isBlank(span[span.length - 1].text)) span.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const s of span) {
        if (s.text.startsWith('+')) fileLines.push(s.text.slice(1));
        else if (s.text === '') fileLines.push('');
        else throw new ParseErr(s.no);
      }
      edits.push({ format: 'v4a', kind: 'add', path, moveTo: null, lines: fileLines, chunks: [] });
    } else if (kind === 'delete') {
      if (span.length > 0) throw new ParseErr(span[0].no);
      edits.push({ format: 'v4a', kind: 'delete', path, moveTo: null, lines: [], chunks: [] });
    } else {
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let seenChunk = false;
      for (let idx = 0; idx < span.length; idx++) {
        const s = span[idx];
        const l = s.text;
        if (idx === 0 && l.startsWith('*** Move to: ')) {
          moveTo = l.slice(13).trim();
          continue;
        }
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          chunks.push(cur);
          seenChunk = true;
          continue;
        }
        if (l === '*** End of File') {
          if (!cur) throw new ParseErr(s.no);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (!cur) {
            if (!seenChunk) {
              cur = { anchor: null, eof: false, body: [] };
              chunks.push(cur);
              seenChunk = true;
            } else {
              throw new ParseErr(s.no);
            }
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', raw: '', mark: false });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), raw: l, mark: false });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), raw: l, mark: false });
          else cur.body.push({ kind: 'add', text: l.slice(1), raw: l, mark: false });
          continue;
        }
        throw new ParseErr(s.no);
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseErr(headerLine);
      edits.push({ format: 'v4a', kind: 'update', path, moveTo, lines: [], chunks });
    }
    i = j;
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function validateJsonEdit(obj: unknown): Edit | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { format: 'json', kind: 'create', path: o.path, text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    if (typeof newStr !== 'string') return null;
    return { format: 'json', kind: 'str_replace', path: o.path, oldStr: o.old_str, newStr };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { format: 'json', kind: 'insert', path: o.path, line: o.insert_line, text: o.new_str };
  }
  return null;
}

function parseJson(patchText: string, lines: string[]): Edit[] {
  const trimmed = patchText.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = undefined;
  }
  if (Array.isArray(parsed)) {
    let startLine = 1;
    for (let k = 0; k < lines.length; k++) {
      if (!isBlank(lines[k])) {
        startLine = k + 1;
        break;
      }
    }
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = validateJsonEdit(el);
      if (!e) throw new ParseErr(startLine);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseErr(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let k = 0; k < lines.length; k++) {
    if (isBlank(lines[k])) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[k]);
    } catch {
      throw new ParseErr(k + 1);
    }
    const e = validateJsonEdit(obj);
    if (!e) throw new ParseErr(k + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseErr(1);
  return edits;
}

function parsePatch(format: string, lines: string[], patchText: string): Edit[] {
  if (format === 'unified') return parseUnified(lines);
  if (format === 'search-replace') return parseSearchReplace(lines);
  if (format === 'v4a') return parseV4A(lines);
  return parseJson(patchText, lines);
}

// ---------------------------------------------------------------------------
// Applying edits (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

type ApplyResult =
  | { ok: true; moved?: { old: string; new: string } }
  | { ok: false; code: string; path: string };

const failWith = (code: string, path: string): ApplyResult => ({ ok: false, code, path });

// Apply a section's hunks in order, each to the result of the ones before
// it. d is the sum over the hunks applied so far of (N's length minus O's
// length). Returns the resulting lines and final-break flag.
function applyHunksToLines(
  lines: string[],
  ends: boolean,
  hunks: Hunk[],
  strict: boolean,
): { ok: true; lines: string[]; ends: boolean } | { ok: false } {
  let cur = [...lines];
  let curEnds = ends;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    const noEol = hunkNoEol(h.body);
    if (o.length === 0) {
      const pos = Math.min(h.a + d, cur.length);
      const atEnd = pos === cur.length;
      const newLines = buildNewLines(cur, pos, o, n, 0);
      cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos)];
      if (atEnd) curEnds = !noEol;
      d += newLines.length;
    } else {
      const found = findTier(cur, o, strict, 0, false);
      if (!found) return { ok: false };
      const target = h.a - 1 + d;
      let best = found.occ[0];
      for (const p of found.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const beforeLen = cur.length;
      const newLines = buildNewLines(cur, best, o, n, found.tier);
      cur = [...cur.slice(0, best), ...newLines, ...cur.slice(best + o.length)];
      if (best + o.length === beforeLen) curEnds = !noEol;
      d += newLines.length - o.length;
    }
  }
  return { ok: true, lines: cur, ends: curEnds };
}

function applyUnified(edit: Extract<Edit, { format: 'unified' }>, tree: Tree, strict: boolean): ApplyResult {
  if (edit.kind === 'create') {
    const np = edit.newPath;
    if (np === null) return failWith('unsafe', '/dev/null');
    if (!isSafePath(np)) return failWith('unsafe', np);
    if (tree.existsAs(np) !== 'absent') return failWith('exists', np);
    const anc = tree.ancestorFile(np);
    if (anc) return failWith('exists', anc);
    const plus: string[] = [];
    let lastAdd: BodyItem | null = null;
    for (const h of edit.hunks) {
      for (const item of h.body) {
        if (item.kind === 'add') {
          plus.push(item.text);
          lastAdd = item;
        }
      }
    }
    // A created file ends with a line break unless a \ line follows its
    // last + line.
    tree.write(np, joinFile(plus, '\n', lastAdd === null || !lastAdd.mark));
    return { ok: true };
  }
  if (edit.kind === 'delete') {
    const op = edit.oldPath;
    if (op === null) return failWith('unsafe', '/dev/null');
    if (!isSafePath(op)) return failWith('unsafe', op);
    if (tree.existsAs(op) !== 'file') return failWith('missing', op);
    tree.delete(op);
    return { ok: true };
  }
  if (edit.kind === 'move') {
    const op = edit.oldPath;
    const np = edit.newPath;
    if (op === null) return failWith('unsafe', '/dev/null');
    if (np === null) return failWith('unsafe', '/dev/null');
    if (!isSafePath(op)) return failWith('unsafe', op);
    if (!isSafePath(np)) return failWith('unsafe', np);
    if (tree.existsAs(op) !== 'file') return failWith('missing', op);
    if (tree.existsAs(np) !== 'absent') return failWith('exists', np);
    const text = tree.read(op);
    if (text === null) return failWith('missing', op);
    const f = splitFile(text);
    const res = applyHunksToLines(f.lines, f.endsWithBreak, edit.hunks, strict);
    if (!res.ok) return failWith('no-match', op);
    const newText = joinFile(res.lines, f.br, res.ends);
    const anc = tree.ancestorFile(np, op);
    if (anc) return failWith('exists', anc);
    tree.delete(op);
    tree.write(np, newText);
    return { ok: true, moved: { old: op, new: np } };
  }
  const op = edit.oldPath;
  if (op === null) return failWith('unsafe', '/dev/null');
  if (!isSafePath(op)) return failWith('unsafe', op);
  if (tree.existsAs(op) !== 'file') return failWith('missing', op);
  const text = tree.read(op);
  if (text === null) return failWith('missing', op);
  const f = splitFile(text);
  const res = applyHunksToLines(f.lines, f.endsWithBreak, edit.hunks, strict);
  if (!res.ok) return failWith('no-match', op);
  const newText = joinFile(res.lines, f.br, res.ends);
  if (newText !== text) tree.write(op, newText);
  return { ok: true };
}

function applySR(edit: Extract<Edit, { format: 'sr' }>, tree: Tree, strict: boolean): ApplyResult {
  const p = edit.path;
  if (!isSafePath(p)) return failWith('unsafe', p);
  if (edit.kind === 'create') {
    if (tree.existsAs(p) !== 'absent') return failWith('exists', p);
    const anc = tree.ancestorFile(p);
    if (anc) return failWith('exists', anc);
    tree.write(p, joinFile(edit.newLines, '\n', true));
    return { ok: true };
  }
  if (tree.existsAs(p) !== 'file') return failWith('missing', p);
  const text = tree.read(p);
  if (text === null) return failWith('missing', p);
  const f = splitFile(text);
  const found = findTier(f.lines, edit.oldLines, strict, 0, false);
  if (!found) return failWith('no-match', p);
  if (found.occ.length > 1) return failWith('ambiguous', p);
  const pos = found.occ[0];
  const n: NewLine[] = edit.newLines.map((t) => ({ text: t, ctx: null }));
  const newLines = buildNewLines(f.lines, pos, edit.oldLines, n, found.tier);
  const out = [...f.lines.slice(0, pos), ...newLines, ...f.lines.slice(pos + edit.oldLines.length)];
  const newText = joinFile(out, f.br, f.endsWithBreak);
  if (newText !== text) tree.write(p, newText);
  return { ok: true };
}

// The first line at or after the cursor equal to the anchor at the first
// tier where one is (SPEC section 8, both sides a single line).
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEquals(lines[i], anchor, t)) return i;
    }
  }
  return -1;
}

function applyV4A(edit: Extract<Edit, { format: 'v4a' }>, tree: Tree, strict: boolean): ApplyResult {
  const p = edit.path;
  if (!isSafePath(p)) return failWith('unsafe', p);
  if (edit.kind === 'add') {
    if (tree.existsAs(p) !== 'absent') return failWith('exists', p);
    const anc = tree.ancestorFile(p);
    if (anc) return failWith('exists', anc);
    tree.write(p, joinFile(edit.lines, '\n', true));
    return { ok: true };
  }
  if (edit.kind === 'delete') {
    if (tree.existsAs(p) !== 'file') return failWith('missing', p);
    tree.delete(p);
    return { ok: true };
  }
  if (edit.moveTo !== null && !isSafePath(edit.moveTo)) return failWith('unsafe', edit.moveTo);
  if (tree.existsAs(p) !== 'file') return failWith('missing', p);
  if (edit.moveTo !== null && tree.existsAs(edit.moveTo) !== 'absent') return failWith('exists', edit.moveTo);
  const text = tree.read(p);
  if (text === null) return failWith('missing', p);
  const f = splitFile(text);
  let cur = [...f.lines];
  let cursor = 0;
  for (const chunk of edit.chunks) {
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const found = findAnchor(cur, chunk.anchor, cursor, strict);
      if (found === -1) return failWith('no-match', p);
      cursor = found + 1;
    }
    const { o, n } = hunkON(chunk);
    if (o.length === 0) {
      const pos = chunk.eof ? cur.length : cursor;
      const newLines = buildNewLines(cur, pos, o, n, 0);
      cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos)];
      cursor = pos + newLines.length;
    } else {
      const found = findTier(cur, o, strict, cursor, chunk.eof);
      if (!found) return failWith('no-match', p);
      const pos = found.occ[0];
      const newLines = buildNewLines(cur, pos, o, n, found.tier);
      cur = [...cur.slice(0, pos), ...newLines, ...cur.slice(pos + o.length)];
      cursor = pos + newLines.length;
    }
  }
  const newText = joinFile(cur, f.br, f.endsWithBreak);
  if (edit.moveTo !== null) {
    const anc = tree.ancestorFile(edit.moveTo, p);
    if (anc) return failWith('exists', anc);
    tree.delete(p);
    tree.write(edit.moveTo, newText);
    return { ok: true, moved: { old: p, new: edit.moveTo } };
  }
  if (newText !== text) tree.write(p, newText);
  return { ok: true };
}

function applyJson(edit: Extract<Edit, { format: 'json' }>, tree: Tree): ApplyResult {
  const p = edit.path;
  if (!isSafePath(p)) return failWith('unsafe', p);
  if (edit.kind === 'create') {
    if (tree.existsAs(p) !== 'absent') return failWith('exists', p);
    const anc = tree.ancestorFile(p);
    if (anc) return failWith('exists', anc);
    tree.write(p, edit.text);
    return { ok: true };
  }
  if (edit.kind === 'str_replace') {
    if (tree.existsAs(p) !== 'file') return failWith('missing', p);
    const text = tree.read(p);
    if (text === null) return failWith('missing', p);
    const f = splitFile(text);
    const crlf = f.br === '\r\n';
    const hay = crlf ? text.replace(/\r\n/g, '\n') : text;
    const oldN = crlf ? edit.oldStr.replace(/\r\n/g, '\n') : edit.oldStr;
    const newN = crlf ? edit.newStr.replace(/\r\n/g, '\n') : edit.newStr;
    const count = countOccurrences(hay, oldN);
    if (count === 0) return failWith('no-match', p);
    if (count > 1) return failWith('ambiguous', p);
    const at = hay.indexOf(oldN);
    const replaced = hay.slice(0, at) + newN + hay.slice(at + oldN.length);
    const newText = crlf ? replaced.replace(/\n/g, '\r\n') : replaced;
    if (newText !== text) tree.write(p, newText);
    return { ok: true };
  }
  if (tree.existsAs(p) !== 'file') return failWith('missing', p);
  const text = tree.read(p);
  if (text === null) return failWith('missing', p);
  const f = splitFile(text);
  if (edit.line < 0 || edit.line > f.lines.length) return failWith('no-match', p);
  // new_str's lines: split at \n, each with one trailing \r removed,
  // without the empty piece after a final \n; an empty new_str has none.
  const newLines = edit.text === '' ? [] : splitPatch(edit.text);
  const out = [...f.lines.slice(0, edit.line), ...newLines, ...f.lines.slice(edit.line)];
  const newText = joinFile(out, f.br, f.endsWithBreak);
  if (newText !== text) tree.write(p, newText);
  return { ok: true };
}

function applyEdit(edit: Edit, tree: Tree, strict: boolean): ApplyResult {
  if (edit.format === 'unified') return applyUnified(edit, tree, strict);
  if (edit.format === 'sr') return applySR(edit, tree, strict);
  if (edit.format === 'v4a') return applyV4A(edit, tree, strict);
  return applyJson(edit, tree);
}

// ---------------------------------------------------------------------------
// Output (SPEC section 2)
// ---------------------------------------------------------------------------

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function computeOutput(tree: Tree, moves: { old: string; new: string }[]): string {
  const entries: { key: string; text: string }[] = [];
  for (const p of tree.paths()) {
    const before = tree.origOf(p);
    const after = tree.afterOf(p);
    const beforeFile = before.kind === 'file';
    if (!beforeFile && after === null) continue;
    if (beforeFile && after !== null && after === before.text) continue;
    if (!beforeFile && after !== null) entries.push({ key: p, text: `A ${p}` });
    else if (beforeFile && after === null) entries.push({ key: p, text: `D ${p}` });
    else entries.push({ key: p, text: `M ${p}` });
  }
  // A move replaces its D and A lines with one R line, when the old path
  // existed before the patch and does not after it, and the new path did
  // not exist before it and does after it. R lines sort by the new path.
  for (const m of moves) {
    const bo = tree.origOf(m.old);
    const ao = tree.afterOf(m.old);
    const bn = tree.origOf(m.new);
    const an = tree.afterOf(m.new);
    if (bo.kind === 'file' && ao === null && bn.kind === 'absent' && an !== null) {
      const di = entries.findIndex((e) => e.text === `D ${m.old}`);
      const ai = entries.findIndex((e) => e.text === `A ${m.new}`);
      if (di !== -1 && ai !== -1) {
        entries.splice(Math.max(di, ai), 1);
        entries.splice(Math.min(di, ai), 1);
        entries.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
      }
    }
  }
  entries.sort((a, b) => byteCompare(a.key, b.key));
  let out = '';
  for (const e of entries) out += `${e.text}\n`;
  out += entries.length === 1 ? 'ok: 1 file\n' : `ok: ${entries.length} files\n`;
  return out;
}

// ---------------------------------------------------------------------------
// Invocation (SPEC section 1)
// ---------------------------------------------------------------------------

function cli(): number {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let positional: string | null = null;
  let afterDD = false;
  let usage = false;
  const seen = new Set<string>();
  for (const arg of args) {
    if (!afterDD && arg === '--') {
      afterDD = true;
      continue;
    }
    if (!afterDD && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (seen.has('format')) usage = true;
        seen.add('format');
        const v = arg.slice(9);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') usage = true;
        else format = v;
      } else if (arg === '--check') {
        if (seen.has('check')) usage = true;
        seen.add('check');
        check = true;
      } else if (arg === '--strict') {
        if (seen.has('strict')) usage = true;
        seen.add('strict');
        strict = true;
      } else {
        usage = true;
      }
      continue;
    }
    if (positional !== null) usage = true;
    else positional = arg;
  }
  if (usage) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  // A usage error wins over everything; then no-patch, then format, then
  // parse, in that order (SPEC section 2).
  let patchText: string;
  try {
    patchText =
      positional === null || positional === '-'
        ? readFileSync(0, 'utf8')
        : readFileSync(positional, 'utf8');
  } catch {
    process.stdout.write('error: no-patch\n');
    return 2;
  }
  const lines = splitPatch(patchText);
  const fmt = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (fmt === null) {
    process.stdout.write('error: format\n');
    return 2;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(fmt, lines, patchText);
  } catch (e) {
    if (e instanceof ParseErr) {
      process.stdout.write(`error: parse ${e.line}\n`);
      return 2;
    }
    throw e;
  }
  const tree = new Tree();
  const failures: { code: string; path: string }[] = [];
  const moves: { old: string; new: string }[] = [];
  for (const edit of edits) {
    const r = applyEdit(edit, tree, strict);
    if (!r.ok) failures.push({ code: r.code, path: r.path });
    else if (r.moved) moves.push(r.moved);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  if (!check) tree.flush();
  process.stdout.write(computeOutput(tree, moves));
  return 0;
}

async function main(): Promise<number> {
  if (process.env.MAKEFUN_ENV_URL) {
    await runTrial(process.env.MAKEFUN_ENV_URL);
    return 0;
  }
  return cli();
}

main().then((code) => {
  process.exitCode = code;
});
