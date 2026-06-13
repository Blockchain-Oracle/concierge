import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATRON_TERMS: ReadonlyArray<[label: string, pattern: RegExp]> = [
  ['BNPL', /\bBNPL\b/i],
  ['Buy-Now-Pay-Later', /Buy.?Now.?Pay.?Later/i],
  ['yield BNPL', /yield.?BNPL/i],
  ['yield spread wedge', /yield.?spread.?wedge/i],
  ['deferred payment', /deferred.?payment/i],
  ['hold and spend', /hold.?(and|&).?spend/i],
  ['spend without selling', /spend.?without.?selling/i],
  // 'Patron' is the predecessor wedge codename — must never appear in
  // user-facing skill text.
  ['Patron', /\bPatron\b/],
];

function readSkillMd(): string {
  return readFileSync(resolve(ROOT, 'SKILL.md'), 'utf-8');
}

/** Round-1: regex frontmatter parse — drops the `yaml` dep without
 *  losing the load-bearing assertions (parseability + required fields). */
function readFrontmatter(md: string): string {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) throw new Error('SKILL.md missing YAML frontmatter');
  return match[1] ?? '';
}

function frontmatterField(fm: string, key: string): string | null {
  // Top-level scalar: `key: value` at line start (not nested).
  const re = new RegExp(`^${key}: *(.*)$`, 'm');
  const m = fm.match(re);
  return m ? (m[1] ?? '').trim() : null;
}

describe('RealClaw skill folder structure', () => {
  it('has SKILL.md at the package root', () => {
    expect(existsSync(resolve(ROOT, 'SKILL.md'))).toBe(true);
  });

  it('has assets/ with placeholder icon + preview', () => {
    expect(statSync(resolve(ROOT, 'assets/icon.svg')).isFile()).toBe(true);
    expect(statSync(resolve(ROOT, 'assets/preview.png')).isFile()).toBe(true);
  });

  it('has scripts/install.sh that is executable', () => {
    const path = resolve(ROOT, 'scripts/install.sh');
    expect(statSync(path).isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect((statSync(path).mode & 0o100) !== 0).toBe(true);
    }
  });

  it('has references/ with quickstart + configuration', () => {
    expect(statSync(resolve(ROOT, 'references/quickstart.md')).isFile()).toBe(true);
    expect(statSync(resolve(ROOT, 'references/configuration.md')).isFile()).toBe(true);
  });

  it('has .skillignore with development excludes + dotfile credential excludes', () => {
    const content = readFileSync(resolve(ROOT, '.skillignore'), 'utf-8');
    // Dev artifacts
    expect(content).toMatch(/\*\.test\.ts/);
    expect(content).toMatch(/__tests__/);
    expect(content).toMatch(/src\//);
    // Round-1 defense-in-depth credential excludes
    expect(content).toMatch(/\.ssh\//);
    expect(content).toMatch(/\.aws\//);
    expect(content).toMatch(/id_rsa\*/);
    expect(content).toMatch(/\*\.pem/);
    expect(content).toMatch(/\*\.key/);
  });
});

describe('SKILL.md frontmatter', () => {
  it('has parseable YAML-style frontmatter delimited by --- ... ---', () => {
    expect(() => readFrontmatter(readSkillMd())).not.toThrow();
  });

  it('declares the RealClaw-required top-level fields', () => {
    const fm = readFrontmatter(readSkillMd());
    for (const k of ['name', 'description', 'version', 'tools', 'permissions']) {
      // tools + permissions are arrays — assert the key line is present.
      const present = new RegExp(`^${k}:`, 'm').test(fm);
      expect(present, `missing frontmatter key: ${k}`).toBe(true);
    }
  });

  it('version is semver-shaped', () => {
    const fm = readFrontmatter(readSkillMd());
    const version = frontmatterField(fm, 'version');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('tools list contains the 6 MCP-exposed tool names (set equality, order-agnostic)', () => {
    // NOTE: this asserts the manifest's CURRENT contract with the MCP server
    // (story-130). If/when @concierge/mcp wires real tools that don't match,
    // either this manifest needs updating OR the MCP tool names need to
    // change — the test failure is the gate, not the bug.
    const md = readSkillMd();
    const expected = [
      'get_agent_state',
      'get_attestation',
      'get_reputation',
      'pause_agent',
      'resume_agent',
      'revoke_session_key',
    ];
    for (const name of expected) {
      expect(md).toContain(`name: ${name}`);
    }
  });

  it('declares read:agent + write:agent OAuth scopes at the top level', () => {
    const md = readSkillMd();
    expect(md).toMatch(/^ *- read:agent$/m);
    expect(md).toMatch(/^ *- write:agent$/m);
  });

  it('every tool declares one of the top-level permission scopes', () => {
    const md = readSkillMd();
    const fm = readFrontmatter(md);
    const toolBlock = fm.match(/^tools:\n([\s\S]*?)(?=^[a-zA-Z]+:|Z)/m)?.[1] ?? '';
    const perms = [...toolBlock.matchAll(/^ *permission: (.*)$/gm)].map((m) => m[1]?.trim());
    expect(perms.length).toBeGreaterThan(0);
    const allowed = new Set(['read:agent', 'write:agent']);
    for (const p of perms) {
      expect(p && allowed.has(p)).toBe(true);
    }
  });
});

describe('Patron contamination guard (load-bearing per AUDIT-2026-06-04)', () => {
  const files = [
    ['SKILL.md', resolve(ROOT, 'SKILL.md')],
    ['quickstart.md', resolve(ROOT, 'references/quickstart.md')],
    ['configuration.md', resolve(ROOT, 'references/configuration.md')],
  ] as const;

  for (const [label, path] of files) {
    for (const [term, re] of PATRON_TERMS) {
      it(`${label} is free of "${term}"`, () => {
        const content = readFileSync(path, 'utf-8');
        expect(content).not.toMatch(re);
      });
    }
  }

  it('SKILL.md description positions Concierge correctly (round-2: agent-verb floor + ≥3 surfaces)', () => {
    // Round-2 (test analyzer #4): the ≥3-of-8 protocol keywords alone is
    // gameable — a Patron-shaped pivot could keep aave/susde/meth as
    // decoration. The agent-autonomy verbs (plan/simulate/execute/attest)
    // are what a BNPL rewrite would have to strip; they're the real gate.
    const md = readSkillMd();
    const fm = readFrontmatter(md);
    const desc = (frontmatterField(fm, 'description') ?? '').toLowerCase();
    expect(desc).toContain('autonomous');
    expect(desc).toContain('mantle');
    // Agent-autonomy verbs: at least 2 of 4 (the tick-loop primitives).
    const agentVerbs = ['plan', 'simulate', 'execute', 'attest'];
    const verbsMentioned = agentVerbs.filter((v) => desc.includes(v));
    expect(verbsMentioned.length).toBeGreaterThanOrEqual(2);
    // Action surface: at least 3 of 8 protocols mentioned.
    const protocols = ['aave', 'susde', 'usdy', 'meth', 'dex', 'bridg', 'erc-8004', 'ethena'];
    const mentioned = protocols.filter((p) => desc.includes(p));
    expect(mentioned.length).toBeGreaterThanOrEqual(3);
  });
});
