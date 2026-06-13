#!/usr/bin/env node
// Zod-based validator for SKILL.md frontmatter. Runs in CI per story-151
// against any PR touching the skill package. Exit 0 on valid, 1 on
// validation failure (with a pointed error message naming the bad field).
//
// Reads the schema from SKILL.md via regex (no YAML dep — same approach
// as the structure tests). The .schema.json sibling is for external tooling
// (editor JSON-Schema validation); this script is the runtime gate.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_MD_PATH = resolve(__dirname, '..', 'SKILL.md');

/** RealClaw skill manifest schema (canonical per story-151). */
const ToolEntry = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, 'tool name must be snake_case'),
  description: z.string().min(10),
  permission: z.string(),
});

// Round-1 security LOW: tighten URL fields to https:// only — z.url() alone
// accepts javascript:/data:/file: schemes which downstream surfaces could
// auto-fetch or render unsafely.
const HttpsUrl = z
  .string()
  .url()
  .refine((u) => /^https:\/\//i.test(u), 'must use https:// scheme');

const SkillManifest = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, 'skill name must be kebab-case'),
  description: z.string().min(20),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be semver MAJOR.MINOR.PATCH'),
  homepage: HttpsUrl,
  repository: HttpsUrl,
  license: z.literal('MIT'),
  mcp_server_url: HttpsUrl,
  // Round-1 security LOW: constrain oauth_client_id to a safe charset so a
  // value can't smuggle '&redirect_uri=evil' into a future OAuth URL.
  oauth_client_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, 'oauth_client_id must be [A-Za-z0-9_-]{1,128}'),
  supported_chains: z.array(z.number().int().positive()).min(1),
  tools: z.array(ToolEntry).min(1),
  permissions: z.array(z.string()).min(1),
});

export type SkillManifest = z.infer<typeof SkillManifest>;

/**
 * Parse SKILL.md frontmatter as YAML-like key:value pairs. Supports:
 *   * top-level scalars (key: value)
 *   * arrays (key:\n  - item\n  - item)
 *   * arrays of objects for `tools` (key:\n  - name: x\n    description: y)
 * No external YAML dep — keeps this validator portable.
 */
export function parseFrontmatter(md: string): Record<string, unknown> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) {
    throw new Error('SKILL.md missing YAML frontmatter (--- ... ---)');
  }
  return parseYamlSubset(match[1] ?? '');
}

function parseYamlSubset(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n');
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(/^([a-z_][a-z0-9_]*): *(.*)$/);
    if (m === null) {
      i++;
      continue;
    }
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    if (value !== '') {
      // Scalar — coerce numbers + booleans, else string.
      out[key] = coerceScalar(value);
      i++;
      continue;
    }
    // Block value: array.
    const items: unknown[] = [];
    i++;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      const itemMatch = next.match(/^ +- *(.*)$/);
      if (itemMatch === null) break;
      const itemValue = itemMatch[1] ?? '';
      // Object detection: line shape `key: value` where key is YAML-id +
      // followed by a SPACE-or-EOL. A bare scalar like `read:agent` has
      // no space after the colon and doesn't match.
      const firstKv = itemValue.match(/^([a-z_]+): +(.*)$/);
      if (firstKv === null) {
        items.push(coerceScalar(itemValue));
        i++;
        continue;
      }
      // Array of objects.
      const objEntries: Record<string, unknown> = {};
      objEntries[firstKv[1] ?? ''] = coerceScalar(firstKv[2] ?? '');
      i++;
      while (i < lines.length) {
        const objLine = lines[i] ?? '';
        const kv = objLine.match(/^ {4}([a-z_]+): *(.*)$/);
        if (kv === null) break;
        objEntries[kv[1] ?? ''] = coerceScalar(kv[2] ?? '');
        i++;
      }
      items.push(objEntries);
    }
    out[key] = items;
  }
  return out;
}

function coerceScalar(v: string): unknown {
  const trimmed = v.trim();
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

export function validateManifest(md: string): SkillManifest {
  const parsed = parseFrontmatter(md);
  const result = SkillManifest.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`SKILL.md manifest validation failed:\n${issues}`);
  }
  return result.data;
}

/**
 * Cross-check: every tool's `permission` MUST appear in the top-level
 * `permissions` allow-list. Catches the case where a new tool is added
 * with a permission that wasn't declared at the manifest level.
 */
export function assertToolPermissionsSubsetOfScopes(m: SkillManifest): void {
  const scopes = new Set(m.permissions);
  for (const tool of m.tools) {
    if (!scopes.has(tool.permission)) {
      throw new Error(
        `tool '${tool.name}' declares permission '${tool.permission}' which is NOT in the top-level permissions allow-list (${[...scopes].join(', ')}).`,
      );
    }
  }
}

function main(): void {
  const md = readFileSync(SKILL_MD_PATH, 'utf-8');
  try {
    const manifest = validateManifest(md);
    assertToolPermissionsSubsetOfScopes(manifest);
    process.stdout.write(
      `✓ SKILL.md validated: ${manifest.name}@${manifest.version} with ${manifest.tools.length} tools, ${manifest.supported_chains.length} chains.\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[validate-manifest] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }
}

// Round-1 (code IMPORTANT): pathToFileURL handles spaces, Windows drive
// letters, and symlinks properly — raw `file://${process.argv[1]}` would
// silently no-op on Windows and on macOS paths-with-spaces.
const argv1 = process.argv[1];
if (argv1 !== undefined && import.meta.url === pathToFileURL(argv1).href) {
  main();
}
