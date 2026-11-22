// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a tree
// of text files, to SPEC.md. Node 22, standard library only.
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// Every edit is applied to an in-memory tree first. A failed edit changes nothing
// and the edits after it still run. When any edit failed, no file is written.
// When none failed, every change is written, unless --check was given.
// With MAKEFUN_ENV_URL set, this file hands the trial over to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** Thrown to answer exit 2 with exactly one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** Thrown by an edit that fails: its code and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed per line, and the empty
 *  piece after a final \n dropped. Line numbers count these lines from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \,
 *  and none of its /-separated segments is empty, . or .. . */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The leading spaces and tabs of a line. */
function leadOf(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line with its leading and trailing spaces and tabs removed. */
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A line with its trailing spaces and tabs removed. */
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A text file as lines: its line break (CRLF when its first line feed follows
 *  a carriage return, LF otherwise), its lines, and whether it ends with one.
 *  An empty file has no lines and does not end with a line break. */
interface FileLines {
  br: string;
  lines: string[];
  finalBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) lines.pop();
  return { br, lines, finalBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 *  the rest read from disk. Moves a move edit made are recorded here so the
 *  output can print R lines for them. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly diskExists = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<{ old: string; next: string }> = [];

  private onDisk(p: string): boolean {
    if (!this.diskExists.has(p)) {
      let v = false;
      try {
        statSync(p);
        v = true;
      } catch {
        v = false;
      }
      this.diskExists.set(p, v);
    }
    return this.diskExists.get(p)!;
  }

  /** The file's original text, or null when it is not a regular file. */
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  /** Current text, or null when the path holds no file right now. */
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  /** Whether the path holds a file right now, or sits on disk in any form. */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    return this.onDisk(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree) => void;

/** One line of a replacement: a context line is written as the file's own
 *  matched line; any other line is written as given (or re-indented at tier 2). */
interface NewLine {
  text: string;
  context: boolean;
  /** Index into O of the context line this replaces, for context lines. */
  oIndex: number;
}

/** Normalise one line for matching at a tier. */
function normAt(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndWs(line);
  return trimBoth(line);
}

/** Every 0-based position where O occurs in lines at one tier. */
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  const want = o.map((l) => normAt(l, tier));
  const have = lines.map((l) => normAt(l, tier));
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (have[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions. */
function matchTiers(lines: string[], o: string[]): { tier: number; positions: number[] } | null {
  for (let tier = 0; tier <= 2; tier += 1) {
    const positions = occurrencesAt(lines, o, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** The first tier at which a single line occurs at or after a cursor. */
function matchSingleAt(lines: string[], line: string, from: number): { tier: number; index: number } | null {
  for (let tier = 0; tier <= 2; tier += 1) {
    const want = normAt(line, tier);
    for (let i = from; i < lines.length; i += 1) {
      if (normAt(lines[i]!, tier) === want) return { tier, index: i };
    }
  }
  return null;
}

/** Replace the k lines at position i with N. Context lines are written as the
 *  file's own matched lines. At tier 2 every other line of N that starts with
 *  P (the leading whitespace of O's first line) has that P replaced by F (the
 *  leading whitespace of the file's first matched line). */
function spliceLines(lines: string[], at: number, k: number, n: NewLine[], tier: number, oFirstLead: string): string[] {
  const firstLead = lines.length > 0 && at < lines.length ? leadOf(lines[at]!) : '';
  const out: string[] = [];
  for (const nl of n) {
    if (nl.context) {
      out.push(lines[at + nl.oIndex]!);
    } else if (tier === 2 && nl.text !== '' && trimBoth(nl.text) !== '' && nl.text.startsWith(oFirstLead)) {
      out.push(firstLead + nl.text.slice(oFirstLead.length));
    } else {
      out.push(nl.text);
    }
  }
  return [...lines.slice(0, at), ...out, ...lines.slice(at + k)];
}

/** Detect the format of a patch, or null when none is detected. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const read = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = read(tree);
      const f = splitFile(before);
      const crlf = f.br === '\r\n';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = read(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.set(p, joinFile({ br: f.br, lines, finalBreak: f.finalBreak }));
    };
  }
  return null;
}

/** Read a patch as JSON edits: one array, or one edit object per line. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: A is its old start line, O its context and - lines,
 *  N its context and + lines, noFinal whether a \ line follows its last
 *  context or + line, plusNoFinal whether one follows its last + line. */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  noFinal: boolean;
  plusNoFinal: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  hdrOld: string | null | undefined;
  hdrNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** Parse a `diff --git a/X b/Y` line, or null when it is not of that form. */
function diffGitPaths(line: string): { a: string; b: string } | null {
  const t = line.trim().split(/\s+/);
  if (t.length !== 4 || t[0] !== 'diff' || t[1] !== '--git') return null;
  if (!t[2]!.startsWith('a/') || t[2]!.length < 3 || !t[3]!.startsWith('b/') || t[3]!.length < 3) return null;
  return { a: t[2]!.slice(2), b: t[3]!.slice(2) };
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to
 *  the first tab, with surrounding spaces removed. /dev/null means no file. */
function headerPath(line: string): string | null {
  const rest = line.slice(4).split('\t')[0]!;
  const p = rest.trim();
  return p === '/dev/null' ? null : p;
}

/** A leading a/ or b/ is removed from a path. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Parse a hunk header line, or null when it is not of the @@ form. */
function hunkHead(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (m === null) return null;
  return Number(m[1]);
}

/** Parse a hunk body starting at start. Returns the hunk and the index of the
 *  first line that is not part of the body. */
function hunkBody(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  interface BodyLine {
    kind: 'ctx' | 'old' | 'new' | 'back';
    text: string;
  }
  const body: BodyLine[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ')) {
      body.push({ kind: 'ctx', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('-')) {
      body.push({ kind: 'old', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('+')) {
      body.push({ kind: 'new', text: l.slice(1) });
      i += 1;
    } else if (l.startsWith('\\')) {
      body.push({ kind: 'back', text: l.slice(1) });
      i += 1;
    } else if (l === '') {
      body.push({ kind: 'ctx', text: '' });
      i += 1;
    } else break;
  }
  while (body.length > 0) {
    const last = body[body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      const oi = o.length;
      o.push(b.text);
      n.push({ text: b.text, context: true, oIndex: oi });
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      n.push({ text: b.text, context: false, oIndex: -1 });
    }
  }
  let noFinal = false;
  let plusNoFinal = false;
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      noFinal = k + 1 < body.length && body[k + 1]!.kind === 'back';
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (body[k]!.kind === 'new') {
      plusNoFinal = k + 1 < body.length && body[k + 1]!.kind === 'back';
      break;
    }
  }
  return { hunk: { a, o, n, noFinal, plusNoFinal }, next: i };
}

/** Apply a section's hunks in order to a file's text. */
function applyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  let f = splitFile(text);
  let d = 0;
  let finalBreak = f.finalBreak;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, f.lines.length);
      const wasEnd = at === f.lines.length;
      const added = h.n.map((nl) => nl.text);
      f = { br: f.br, lines: [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)], finalBreak };
      if (wasEnd) finalBreak = !h.noFinal;
      d += h.n.length;
      continue;
    }
    let m: { tier: number; positions: number[] } | null = null;
    if (strict) {
      const positions = occurrencesAt(f.lines, h.o, 0);
      if (positions.length > 0) m = { tier: 0, positions };
    } else {
      m = matchTiers(f.lines, h.o);
    }
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    for (const pos of m.positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const touchesEnd = best + h.o.length === f.lines.length;
    const lines = spliceLines(f.lines, best, h.o.length, h.n, m.tier, leadOf(h.o[0]!));
    if (touchesEnd) finalBreak = !h.noFinal;
    f = { br: f.br, lines, finalBreak };
    d += h.n.length - h.o.length;
  }
  return joinFile({ br: f.br, lines: f.lines, finalBreak });
}

/** Read a patch as unified-diff edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasHdrDash = false;
  const startFromGit = (g: { a: string; b: string }): void => {
    cur = { gitOld: g.a, gitNew: g.b, hdrOld: undefined, hdrNew: undefined, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasHdrDash = false;
  };
  const startFromPair = (oldP: string | null, newP: string | null): void => {
    cur = { gitOld: undefined, gitNew: undefined, hdrOld: oldP, hdrNew: newP, renOld: undefined, renNew: undefined, create: false, del: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasHdrDash = true;
  };
  const readHunk = (i: number): number => {
    const a = hunkHead(lines[i]!);
    if (a === null) throw new Exit2(`error: parse ${i + 1}`);
    const r = hunkBody(lines, i + 1, a);
    cur!.hunks.push(r.hunk);
    inHeader = false;
    return r.next;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (cur === null) {
      if (l.startsWith('diff --git ')) {
        const g = diffGitPaths(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startFromGit(g);
        i += 1;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startFromPair(headerPath(l), headerPath(lines[i + 1]!));
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i += 1;
      }
      continue;
    }
    if (inHeader) {
      if (l.startsWith('@@')) {
        i = readHunk(i);
      } else if (l.startsWith('diff --git ')) {
        const g = diffGitPaths(l);
        if (g === null) throw new Exit2(`error: parse ${i + 1}`);
        startFromGit(g);
        i += 1;
      } else if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!hasHdrDash) {
            cur.hdrOld = headerPath(l);
            cur.hdrNew = headerPath(lines[i + 1]!);
            hasHdrDash = true;
            i += 2;
          } else {
            startFromPair(headerPath(l), headerPath(lines[i + 1]!));
            i += 2;
          }
        } else {
          throw new Exit2(`error: parse ${i + 2}`);
        }
      } else if (l.startsWith('+++ ')) {
        if (cur.hdrNew === undefined) cur.hdrNew = headerPath(l);
        i += 1;
      } else if (l.startsWith('rename from ')) {
        if (cur.renOld === undefined) cur.renOld = l.slice('rename from '.length);
        i += 1;
      } else if (l.startsWith('rename to ')) {
        if (cur.renNew === undefined) cur.renNew = l.slice('rename to '.length);
        i += 1;
      } else if (l.startsWith('new file mode')) {
        cur.create = true;
        i += 1;
      } else if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i += 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (l.startsWith('@@')) {
      i = readHunk(i);
    } else if (l.startsWith('diff --git ')) {
      const g = diffGitPaths(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      startFromGit(g);
      i += 1;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startFromPair(headerPath(l), headerPath(lines[i + 1]!));
      i += 2;
    } else {
      i += 1;
    }
  }
  const edits: Edit[] = [];
  for (const s of sections) {
    const oldP = s.hdrOld !== undefined ? s.hdrOld : s.renOld !== undefined ? s.renOld : s.gitOld !== undefined ? s.gitOld : null;
    const newP = s.hdrNew !== undefined ? s.hdrNew : s.renNew !== undefined ? s.renNew : s.gitNew !== undefined ? s.gitNew : null;
    const oldPath = oldP === null ? null : stripAB(oldP);
    const newPath = newP === null ? null : stripAB(newP);
    const isCreate = s.create || oldP === null;
    const isDelete = !isCreate && (s.del || newP === null);
    if (isCreate) {
      const np = newPath;
      edits.push((tree) => {
        if (np === null) return;
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.exists(np)) throw new Fail('exists', np);
        const plus: string[] = [];
        let plusNoFinal = false;
        for (const h of s.hunks) {
          let hasPlus = false;
          for (const nl of h.n) {
            if (!nl.context) {
              plus.push(nl.text);
              hasPlus = true;
            }
          }
          if (hasPlus) plusNoFinal = h.plusNoFinal;
        }
        tree.set(np, plus.length === 0 ? '' : `${plus.join('\n')}${plusNoFinal ? '' : '\n'}`);
      });
    } else if (isDelete) {
      const op = oldPath;
      edits.push((tree) => {
        if (op === null) return;
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.set(op, null);
      });
    } else if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      const op = oldPath;
      const np = newPath;
      edits.push((tree) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (!safe(np)) throw new Fail('unsafe', np);
        const before = tree.get(op);
        if (before === null) throw new Fail('missing', op);
        if (tree.exists(np)) throw new Fail('exists', np);
        const out = applyHunks(before, s.hunks, op, strict);
        tree.set(op, null);
        tree.set(np, out);
        tree.moves.push({ old: op, next: np });
      });
    } else {
      const p = oldPath ?? newPath;
      edits.push((tree) => {
        if (p === null) return;
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        tree.set(p, applyHunks(before, s.hunks, p, strict));
      });
    }
  }
  return edits;
}

/** Read a patch as SEARCH/REPLACE blocks (SPEC.md section 7). */
function srEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    o: string[];
    n: NewLine[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let lastEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= lastEnd; k -= 1) {
      const l = lines[k]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let sep = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '=======') {
        sep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const o = lines.slice(searchIdx + 1, sep);
    const n: NewLine[] = lines.slice(sep + 1, end).map((text) => ({ text, context: false, oIndex: -1 }));
    blocks.push({ path, o, n });
    prevPath = path;
    lastEnd = end + 1;
    i = end + 1;
  }
  const edits: Edit[] = [];
  for (const b of blocks) {
    const p = b.path;
    const o = b.o;
    const n = b.n;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.set(p, n.length === 0 ? '' : `${n.map((nl) => nl.text).join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      let m: { tier: number; positions: number[] } | null = null;
      if (strict) {
        const positions = occurrencesAt(f.lines, o, 0);
        if (positions.length > 0) m = { tier: 0, positions };
      } else {
        m = matchTiers(f.lines, o);
      }
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const lines = spliceLines(f.lines, m.positions[0]!, o.length, n, m.tier, leadOf(o[0]!));
      tree.set(p, joinFile({ br: f.br, lines, finalBreak: f.finalBreak }));
    });
  }
  return edits;
}

/** One V4A chunk: anchor is null when there is none, eof when a
 *  *** End of File line ends it, body its raw body lines. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

/** A chunk's body lines as O (context and - lines) and N (context and +
 *  lines, context lines flagged with their index into O). */
function chunkLines(body: string[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.startsWith(' ')) {
      const oi = o.length;
      o.push(b.slice(1));
      n.push({ text: b.slice(1), context: true, oIndex: oi });
    } else if (b.startsWith('-')) {
      o.push(b.slice(1));
    } else if (b.startsWith('+')) {
      n.push({ text: b.slice(1), context: false, oIndex: -1 });
    } else if (b === '') {
      const oi = o.length;
      o.push('');
      n.push({ text: '', context: true, oIndex: oi });
    }
  }
  return { o, n };
}

/** Read a patch as a V4A patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i += 1;
      const fileLines: string[] = [];
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('+')) {
          fileLines.push(x.slice(1));
          i += 1;
        } else if (x === '') {
          fileLines.push('');
          i += 1;
        } else if (x.trim() === '') {
          let j = i + 1;
          while (j < last && blank(lines[j]!)) j += 1;
          if (j >= last || isSectionStart(lines[j]!)) break;
          throw new Exit2(`error: parse ${i + 1}`);
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.set(p, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && blank(lines[i]!)) i += 1;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.set(p, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i;
      i += 1;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const flush = (): void => {
        if (cur === null) return;
        chunks.push(cur);
        cur = null;
      };
      while (i < last) {
        const x = lines[i]!;
        if (isSectionStart(x)) break;
        if (x.startsWith('@@')) {
          flush();
          const a = x.slice(2).trim();
          cur = { anchor: a === '' ? null : a, eof: false, body: [] };
          i += 1;
          continue;
        }
        if (x.trim() === '*** End of File') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.eof = true;
          flush();
          i += 1;
          continue;
        }
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || x === '') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push(x);
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      flush();
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') lastChunk.body.pop();
        if (lastChunk.body.length === 0 && lastChunk.anchor === null && !lastChunk.eof) chunks.pop();
      }
      const chunkParts = chunks.map((c) => ({ ...chunkLines(c.body), anchor: c.anchor, eof: c.eof }));
      if (chunkParts.length === 0 && moveTo === undefined) throw new Exit2(`error: parse ${updateLine + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== undefined && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        if (moveTo !== undefined && tree.exists(moveTo)) throw new Fail('exists', moveTo);
        let f = splitFile(before);
        let cursor = 0;
        for (const c of chunkParts) {
          if (c.anchor !== null) {
            let found: { tier: number; index: number } | null = null;
            if (strict) {
              const want = c.anchor;
              for (let k = cursor; k < f.lines.length; k += 1) {
                if (f.lines[k] === want) {
                  found = { tier: 0, index: k };
                  break;
                }
              }
            } else {
              found = matchSingleAt(f.lines, c.anchor, cursor);
            }
            if (found === null) throw new Fail('no-match', p);
            cursor = found.index + 1;
          }
          if (c.o.length === 0) {
            const at = c.eof ? f.lines.length : cursor;
            const added = c.n.map((nl) => nl.text);
            const lines = [...f.lines.slice(0, at), ...added, ...f.lines.slice(at)];
            f = { br: f.br, lines, finalBreak: f.finalBreak };
            cursor = at + added.length;
            continue;
          }
          let hit: { tier: number; pos: number } | null = null;
          const tiers = strict ? [0] : [0, 1, 2];
          for (const tier of tiers) {
            const positions = occurrencesAt(f.lines, c.o, tier).filter((pos) => pos >= cursor);
            const ok = c.eof ? positions.filter((pos) => pos + c.o.length === f.lines.length) : positions;
            if (ok.length > 0) {
              hit = { tier, pos: ok[0]! };
              break;
            }
          }
          if (hit === null) throw new Fail('no-match', p);
          const lines = spliceLines(f.lines, hit.pos, c.o.length, c.n, hit.tier, leadOf(c.o[0]!));
          f = { br: f.br, lines, finalBreak: f.finalBreak };
          cursor = hit.pos + c.n.length;
        }
        const out = joinFile(f);
        if (moveTo !== undefined) {
          tree.set(p, null);
          tree.set(moveTo, out);
          tree.moves.push({ old: p, next: moveTo });
        } else {
          tree.set(p, out);
        }
      });
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const m of tree.moves) {
    const wasOld = tree.original(m.old);
    const nowOld = tree.get(m.old);
    const wasNew = tree.original(m.next);
    const nowNew = tree.get(m.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: m.next, line: `R ${m.old} -> ${m.next}` });
      covered.add(m.old);
      covered.add(m.next);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
