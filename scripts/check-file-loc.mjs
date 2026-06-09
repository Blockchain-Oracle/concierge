#!/usr/bin/env node
// Defense-in-depth LOC cap (400 significant lines) for the Concierge monorepo.
// Biome's noExcessiveLinesPerFile (nursery rule, 2.4.16) is the CI authority.
// This script is the fast pre-commit guard that runs before Biome boots.
//
// Exit codes
//   0 — all files within budget
//   1 — one or more files over budget (paths + counts printed to stderr)
//   2 — config error (missing root dir, non-UTF-8 file, unknown flag) — NEVER silent
//
// Named exclude sets (NOT substring match — substring silently misexcludes
// `apps/foo/rebuild/widget.ts` because it contains `build`). Per
// rapid-agents/scripts/check_max_lines.py and feedback_cicd_pattern.md.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import process from 'node:process';

const REPO_ROOT = process.cwd();
const MAX_LINES = 400;

const ROOTS = [
  'apps',
  'packages',
  'scripts',
  'contracts/src',
  'contracts/test',
  'contracts/script',
];

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.sol']);
const EXCLUDE_FILENAMES = new Set();
const EXCLUDE_SUFFIXES = new Set(['.d.ts']);
const EXCLUDE_DIR_COMPONENTS = new Set([
  '_vendored',
  'node_modules',
  '.next',
  'dist',
  'build',
  'broadcast',
  '.wrangler',
  'out',
  '.turbo',
  'coverage',
  'abi',
]);

const KNOWN_FLAGS = new Set(['--strict']);
const COMMENT_PREFIXES = ['//', '#', '/*', '*', '<!--'];

function parseArgs(argv) {
  const unknown = argv.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`check-file-loc: unknown flag(s): ${unknown.join(', ')}`);
    console.error(`Known flags: ${[...KNOWN_FLAGS].join(', ')}`);
    process.exit(2);
  }
}

function isExcludedPath(rel) {
  const parts = rel.split(sep);
  for (const part of parts) {
    if (EXCLUDE_DIR_COMPONENTS.has(part)) return true;
  }
  const base = parts[parts.length - 1];
  if (EXCLUDE_FILENAMES.has(base)) return true;
  for (const suf of EXCLUDE_SUFFIXES) {
    if (base.endsWith(suf)) return true;
  }
  return false;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

function countSignificantLines(filePath) {
  const buf = readFileSync(filePath);
  let text;
  try {
    text = STRICT_UTF8.decode(buf);
  } catch (e) {
    throw new Error(
      `UTF-8 decode error: ${filePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const lines = text.split(/\r?\n/);
  let significant = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (t.length === 0) continue;
    let isComment = false;
    for (const p of COMMENT_PREFIXES) {
      if (t.startsWith(p)) {
        isComment = true;
        break;
      }
    }
    if (!isComment) significant += 1;
  }
  return significant;
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read directory ${dir}: ${e.message}`);
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    const rel = relative(REPO_ROOT, full);
    if (isExcludedPath(rel)) continue;
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (EXTENSIONS.has(ext)) yield full;
    }
  }
}

function main(argv) {
  parseArgs(argv);

  // Roots check — at least one declared root must exist. Missing-all = config error.
  const existingRoots = [];
  for (const r of ROOTS) {
    const full = resolve(REPO_ROOT, r);
    try {
      const s = statSync(full);
      if (s.isDirectory()) existingRoots.push(full);
    } catch {
      // missing — that's OK as long as at least one root exists
    }
  }
  if (existingRoots.length === 0) {
    console.error(
      `check-file-loc: no scannable roots exist under ${REPO_ROOT}. Expected at least one of: ${ROOTS.join(', ')}`,
    );
    process.exit(2);
  }

  const violations = [];
  for (const rootDir of existingRoots) {
    for (const filePath of walk(rootDir)) {
      let count;
      try {
        count = countSignificantLines(filePath);
      } catch (e) {
        console.error(`check-file-loc: ${e.message}`);
        process.exit(2);
      }
      if (count > MAX_LINES) {
        violations.push({
          path: relative(REPO_ROOT, filePath),
          count,
          over: count - MAX_LINES,
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-file-loc: ${violations.length} file(s) exceed ${MAX_LINES}-line cap`);
    for (const v of violations) {
      console.error(`  ${v.path}: ${v.count} lines (over by ${v.over})`);
    }
    process.exit(1);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  console.error(`check-file-loc: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
