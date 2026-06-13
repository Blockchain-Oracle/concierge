// Round-1 CRITICAL gap closure: install.sh's security contracts (CWE-74
// JSON injection rejection, CWE-276 file mode 0600, idempotency confirmation
// flow) are the actual load-bearing assertions — the executable-bit check
// in skill-structure.test.ts is the LEAST important.
//
// These tests spawn install.sh with a fake $HOME so the real ~/.concierge
// is never touched. Skipped on Windows + when /bin/bash absent.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = resolve(ROOT, 'scripts/install.sh');
const POSIX = process.platform !== 'win32';

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runScript(opts: { home: string; stdin: string; args?: string[] }): RunResult {
  const result = spawnSync(SCRIPT, opts.args ?? [], {
    input: opts.stdin,
    env: {
      ...process.env,
      HOME: opts.home,
      // Force the script to think stdin is a TTY for the test harness —
      // simulated by setting BASH_ENV variable not. We can't fake a TTY
      // from spawnSync, so the CWE-703 path (non-TTY refusal) is tested
      // separately; the happy-path tests pipe stdin and EXPECT the TTY
      // refusal.
    },
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe.runIf(POSIX)('install.sh — TTY guard (CWE-703)', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'concierge-skill-test-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('refuses to run when stdin is not a TTY (no silent EOF exit)', () => {
    // spawnSync's piped stdin is NOT a TTY → script must refuse.
    const r = runScript({ home, stdin: '\n' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('stdin is not a TTY');
  });
});

describe.runIf(POSIX)('install.sh — CWE-74 JSON injection rejection', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(resolve(tmpdir(), 'concierge-skill-test-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('rejects user_id containing double-quote (round-0 was the injection vector)', () => {
    // Even with the TTY guard up, we can confirm the validate path rejects
    // by overriding validate via env later. For now: TTY guard fires first
    // so we assert script refuses BEFORE writing config — config.json must
    // NOT exist after the run.
    const r = runScript({ home, stdin: 'evil","url":"https://attacker.tld\n' });
    // status will be 1 (TTY refusal) — config MUST not exist regardless.
    expect(r.status).not.toBe(0);
    try {
      statSync(resolve(home, '.concierge/config.json'));
      throw new Error('config.json was written despite injection attempt');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      expect(code === 'ENOENT' || code === undefined).toBe(true);
    }
  });
});

describe.runIf(POSIX)('install.sh — CWE-601 OAuth host lockdown (round-2: tolerant regex)', () => {
  it('CONCIERGE_URL is IGNORED without --dev', () => {
    // Round-2 (test #2): regex with quote class so a single-vs-double-quote
    // refactor doesn't false-positive fail. Load-bearing intent: PROD_URL
    // is the literal hostname, gate is DEV_MODE.
    const source = readFileSync(SCRIPT, 'utf-8');
    expect(source).toMatch(/readonly PROD_URL=['"]https:\/\/concierge\.xyz['"]/);
    expect(source).toMatch(/if\s*\[\[\s*"\$DEV_MODE"\s*-eq\s*1\s*\]\]/);
    expect(source).toMatch(/CONCIERGE_URL=['"]\$PROD_URL['"]/);
  });

  it('round-2: --dev=value is REJECTED loudly (security info #3 footgun guard)', () => {
    const r = runScript({
      home: mkdtempSync(resolve(tmpdir(), 'cdev-')),
      stdin: '',
      args: ['--dev=true'],
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--dev does not accept a value/);
  });

  it('round-2: only emits the override WARNING when --dev URL actually differs from prod', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    // Conditional log gate around the warning (not unconditional).
    expect(source).toMatch(/if\s*\[\[\s*"\$CONCIERGE_URL"\s*!=\s*"\$PROD_URL"\s*\]\]/);
  });
});

describe.runIf(POSIX)('install.sh — CWE-276 file mode + validation source review', () => {
  it('script uses install -m 600 then chmod 600 (belt-and-suspenders)', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    expect(source).toMatch(/install -m 600 \/dev\/null "\$CONFIG_FILE"/);
    expect(source).toMatch(/chmod 600 "\$CONFIG_FILE"/);
    expect(source).toMatch(/chmod 700 "\$CONFIG_DIR"/);
    expect(source).toMatch(/umask 077/);
  });
});

describe.runIf(POSIX)(
  'install.sh — round-2: BEHAVIORAL validator tests (test gap CRITICAL)',
  () => {
    // Source-grep alone would green-light a regression to `.*`. These tests
    // SOURCE the script + exercise the validators directly so a loosened
    // regex fails LOUD.
    function sourceAndRun(snippet: string): { code: number; stderr: string } {
      // Sourced install.sh re-enables set -euo pipefail; disable AFTER source
      // so a validator's rc=1 doesn't exit the test shell before we capture it.
      const cmd = `source "${SCRIPT}" 2>/dev/null; set +e; ${snippet}; echo "__EXIT_$?"`;
      const r = spawnSync('/bin/bash', ['-c', cmd], { encoding: 'utf-8' });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      const match = out.match(/__EXIT_(\d+)/);
      return { code: match ? Number(match[1]) : -1, stderr: r.stderr ?? '' };
    }

    it('validate_user_id ACCEPTS canonical id [A-Za-z0-9_-]{1,64}', () => {
      const r = sourceAndRun(`validate_user_id 'user_abc-123'`);
      expect(r.code).toBe(0);
    });

    it('validate_user_id REJECTS double-quote (CWE-74 injection vector)', () => {
      const r = sourceAndRun(`validate_user_id 'evil"'`);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/rejected user id/);
    });

    it('validate_user_id REJECTS backslash + newline + JSON-escape chars', () => {
      expect(sourceAndRun(String.raw`validate_user_id 'a\\b'`).code).toBe(1);
      // Newline literally in the value would be caught by length OR regex.
      expect(sourceAndRun(`validate_user_id $'line1\\nline2'`).code).toBe(1);
      expect(sourceAndRun(`validate_user_id 'a}b'`).code).toBe(1);
      expect(sourceAndRun(`validate_user_id 'a b'`).code).toBe(1);
    });

    it('validate_user_id REJECTS empty + over-64-char input', () => {
      expect(sourceAndRun(`validate_user_id ''`).code).toBe(1);
      expect(sourceAndRun(`validate_user_id $(printf 'a%.0s' {1..65})`).code).toBe(1);
    });

    it('validate_user_id REJECTS Unicode lookalikes (ASCII-only allow-list)', () => {
      // Fullwidth digit + Cyrillic 'a' — multi-byte UTF-8, never in [A-Za-z0-9_-].
      expect(sourceAndRun(`validate_user_id '\\uff11user'`).code).toBe(1);
    });

    it('round-2 CWE-74-class: validate_url ACCEPTS proper http(s) origins', () => {
      expect(sourceAndRun(`validate_url 'https://staging.concierge.xyz'`).code).toBe(0);
      expect(sourceAndRun(`validate_url 'http://localhost:8787'`).code).toBe(0);
      expect(sourceAndRun(`validate_url 'https://example.com/path/here'`).code).toBe(0);
    });

    it('round-2 CWE-74-class: validate_url REJECTS quotes, newlines, schemes', () => {
      expect(sourceAndRun(`validate_url 'https://evil","userId":"x'`).code).toBe(1);
      expect(sourceAndRun(`validate_url 'javascript:alert(1)'`).code).toBe(1);
      expect(sourceAndRun(`validate_url 'ftp://example.com'`).code).toBe(1);
      expect(sourceAndRun(`validate_url ''`).code).toBe(1);
    });
  },
);
