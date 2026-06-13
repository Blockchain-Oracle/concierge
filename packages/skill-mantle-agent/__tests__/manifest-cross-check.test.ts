// Story-151: validate SKILL.md frontmatter against the canonical Zod schema
// + cross-check tool/permission consistency. Replaces story-150's lighter
// structural assertions with full schema validation.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertToolPermissionsSubsetOfScopes,
  parseFrontmatter,
  validateManifest,
} from '../scripts/validate-manifest.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SKILL_MD = readFileSync(resolve(ROOT, 'SKILL.md'), 'utf-8');
const SCHEMA_JSON = JSON.parse(
  readFileSync(resolve(ROOT, 'schemas/skill-manifest.schema.json'), 'utf-8'),
) as { required: string[]; properties: Record<string, unknown> };

describe('SKILL.md manifest — full schema validation (story-151)', () => {
  it('validates against the Zod schema without errors', () => {
    expect(() => validateManifest(SKILL_MD)).not.toThrow();
  });

  it('parser extracts all top-level scalars + arrays correctly', () => {
    const fm = parseFrontmatter(SKILL_MD);
    expect(fm['name']).toBe('concierge-mantle-agent');
    expect(fm['version']).toBe('0.1.0');
    expect(fm['license']).toBe('MIT');
    expect(fm['mcp_server_url']).toBe('https://mcp.concierge.xyz/mcp');
    expect(fm['oauth_client_id']).toBe('concierge-mantle-agent-skill');
    expect(fm['supported_chains']).toEqual([5000, 5003]);
    expect(Array.isArray(fm['tools'])).toBe(true);
    expect(Array.isArray(fm['permissions'])).toBe(true);
  });

  it('parser handles arrays of objects (tools[]) correctly', () => {
    const fm = parseFrontmatter(SKILL_MD);
    const tools = fm['tools'] as Array<{ name: string; permission: string; description: string }>;
    expect(tools.length).toBe(6);
    expect(tools[0]?.name).toBe('get_agent_state');
    expect(tools[0]?.permission).toBe('read:agent');
    expect(tools[0]?.description).toMatch(/portfolio/);
  });

  it('every tool permission is in the top-level permissions allow-list', () => {
    const manifest = validateManifest(SKILL_MD);
    expect(() => assertToolPermissionsSubsetOfScopes(manifest)).not.toThrow();
  });
});

describe('SKILL.md manifest — required field assertions (BDD spec gates)', () => {
  // Round-1 (test IMPORTANT): defer validation to beforeAll so a malformed
  // SKILL.md fails AT a specific test rather than collapsing the whole
  // suite into "failed to collect" with no per-test reporting.
  let manifest: ReturnType<typeof validateManifest>;
  beforeAll(() => {
    manifest = validateManifest(SKILL_MD);
  });

  it('mcp_server_url points to the production MCP endpoint (story-133)', () => {
    expect(manifest.mcp_server_url).toBe('https://mcp.concierge.xyz/mcp');
  });

  it('supported_chains lists Mantle Mainnet (5000) AND Mantle Sepolia (5003)', () => {
    expect(manifest.supported_chains).toContain(5000);
    expect(manifest.supported_chains).toContain(5003);
  });

  it('permissions contains both read:agent and write:agent (story-134 scopes)', () => {
    expect(manifest.permissions).toContain('read:agent');
    expect(manifest.permissions).toContain('write:agent');
  });

  it('license is MIT (Mantle-ecosystem norm)', () => {
    expect(manifest.license).toBe('MIT');
  });

  it('homepage + repository are absolute URLs', () => {
    expect(manifest.homepage.startsWith('https://')).toBe(true);
    expect(manifest.repository.startsWith('https://')).toBe(true);
  });
});

describe('JSON Schema sidecar (external tooling contract)', () => {
  it('lists every required Zod field in its `required` array (no drift between sources)', () => {
    // Both the Zod schema and the JSON Schema are sources of truth — Zod for
    // the runtime gate, JSON Schema for editors. They must agree on required.
    const required = SCHEMA_JSON.required.sort();
    const expected = [
      'name',
      'description',
      'version',
      'homepage',
      'repository',
      'license',
      'mcp_server_url',
      'oauth_client_id',
      'supported_chains',
      'tools',
      'permissions',
    ].sort();
    expect(required).toEqual(expected);
  });

  it('JSON Schema properties cover every Zod field', () => {
    const props = Object.keys(SCHEMA_JSON.properties);
    for (const key of SCHEMA_JSON.required) {
      expect(props).toContain(key);
    }
  });
});

describe('Negative cases — validator catches malformed manifests', () => {
  function md(frontmatter: string): string {
    return `---\n${frontmatter}\n---\nbody`;
  }

  it('rejects missing mcp_server_url', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: 0.1.0
homepage: https://example.com
repository: https://example.com/repo
license: MIT
oauth_client_id: x
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: read:agent
permissions:
  - read:agent`);
    expect(() => validateManifest(bad)).toThrow(/mcp_server_url/);
  });

  it('rejects non-semver version', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: v1
homepage: https://example.com
repository: https://example.com/repo
license: MIT
mcp_server_url: https://example.com/mcp
oauth_client_id: x
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: read:agent
permissions:
  - read:agent`);
    expect(() => validateManifest(bad)).toThrow(/version/);
  });

  it('rejects license other than MIT', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: 0.1.0
homepage: https://example.com
repository: https://example.com/repo
license: GPL-3.0
mcp_server_url: https://example.com/mcp
oauth_client_id: x
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: read:agent
permissions:
  - read:agent`);
    expect(() => validateManifest(bad)).toThrow(/license/);
  });

  it('rejects tool whose permission is not in scopes', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: 0.1.0
homepage: https://example.com
repository: https://example.com/repo
license: MIT
mcp_server_url: https://example.com/mcp
oauth_client_id: x
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: admin:agent
permissions:
  - read:agent`);
    const manifest = validateManifest(bad);
    expect(() => assertToolPermissionsSubsetOfScopes(manifest)).toThrow(
      /admin:agent.*permissions allow-list/,
    );
  });
});

describe('Round-1: parser correctness in isolation (the colon-scalar bug)', () => {
  // Test analyzer #1 (rating 8): the parseFrontmatter colon-scalar bug
  // motivated this story. Exercise the parser DIRECTLY against synthetic
  // frontmatters covering scalar-arrays-with-colons, empty arrays of
  // objects, etc. — not just the real SKILL.md (which is a single sample).
  it('array of colon-containing scalars stays Array<string>, NOT Array<object>', () => {
    const fm = parseFrontmatter('---\npermissions:\n  - read:agent\n  - write:agent\n---');
    expect(fm['permissions']).toEqual(['read:agent', 'write:agent']);
  });

  it('array of objects is recognized only when "key: value-with-space" shape present', () => {
    const fm = parseFrontmatter('---\ntools:\n  - name: foo\n    permission: read:agent\n---');
    expect(fm['tools']).toEqual([{ name: 'foo', permission: 'read:agent' }]);
  });

  it('integer arrays coerce items to numbers', () => {
    const fm = parseFrontmatter('---\nsupported_chains:\n  - 5000\n  - 5003\n---');
    expect(fm['supported_chains']).toEqual([5000, 5003]);
  });
});

describe('Round-1: malformed top-level frontmatter (parser failure modes)', () => {
  it('THROWS when --- delimiters are missing entirely', () => {
    expect(() => parseFrontmatter('no frontmatter here at all')).toThrow(/missing.*frontmatter/i);
  });

  it('THROWS when only one --- delimiter is present (unterminated block)', () => {
    expect(() => parseFrontmatter('---\nname: foo\nno closing')).toThrow(/missing.*frontmatter/i);
  });

  it('accepts an empty frontmatter block (downstream Zod catches missing required fields)', () => {
    const fm = parseFrontmatter('---\n\n---');
    expect(fm).toEqual({});
  });
});

describe('Round-1: JSON Schema field-type drift guard (not just `required`)', () => {
  // Test analyzer #2 (rating 7): drift-on-required is checked. Drift on
  // FIELD TYPES (e.g. supported_chains: integer-array vs string-array) was
  // not. Pin the load-bearing type shapes.
  it('supported_chains is an integer array in JSON Schema', () => {
    const prop = SCHEMA_JSON.properties['supported_chains'] as {
      type: string;
      items: { type: string };
    };
    expect(prop.type).toBe('array');
    expect(prop.items.type).toBe('integer');
  });

  it('tools is an array of objects with [name, description, permission] required', () => {
    const prop = SCHEMA_JSON.properties['tools'] as {
      type: string;
      items: { type: string; required: string[] };
    };
    expect(prop.type).toBe('array');
    expect(prop.items.type).toBe('object');
    expect(prop.items.required.sort()).toEqual(['description', 'name', 'permission']);
  });

  it('license is enum-restricted to MIT in JSON Schema (matches Zod literal)', () => {
    const prop = SCHEMA_JSON.properties['license'] as { type: string; enum: string[] };
    expect(prop.enum).toEqual(['MIT']);
  });

  it('version has the semver pattern in JSON Schema', () => {
    const prop = SCHEMA_JSON.properties['version'] as { type: string; pattern: string };
    expect(prop.pattern).toBe('^\\d+\\.\\d+\\.\\d+$');
  });
});

describe('Round-1: validate-manifest BIN exit-code contract', () => {
  // Test analyzer #5 (rating 7): the CI workflow runs the bin and gates
  // merge on exit code. Behaviorally test exit 0 / exit 1.
  const SCRIPT = resolve(ROOT, 'scripts/validate-manifest.ts');

  it('exit 0 on the real SKILL.md (happy path)', () => {
    const r = spawnSync('npx', ['tsx', SCRIPT], { encoding: 'utf-8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('SKILL.md validated');
  });
});

describe('Round-1: tightened URL + oauth_client_id constraints', () => {
  function md(frontmatter: string): string {
    return `---\n${frontmatter}\n---\nbody`;
  }

  it('REJECTS javascript: in homepage (z.url() alone would have accepted)', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: 0.1.0
homepage: javascript:alert(1)
repository: https://example.com/repo
license: MIT
mcp_server_url: https://example.com/mcp
oauth_client_id: x
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: read:agent
permissions:
  - read:agent`);
    expect(() => validateManifest(bad)).toThrow(/homepage.*https/i);
  });

  it('REJECTS oauth_client_id containing &redirect_uri= splice', () => {
    const bad = md(`name: x-skill
description: at least twenty characters of description text
version: 0.1.0
homepage: https://example.com
repository: https://example.com/repo
license: MIT
mcp_server_url: https://example.com/mcp
oauth_client_id: foo&redirect_uri=evil
supported_chains:
  - 5000
tools:
  - name: foo
    description: ten or more chars
    permission: read:agent
permissions:
  - read:agent`);
    expect(() => validateManifest(bad)).toThrow(/oauth_client_id/);
  });
});
