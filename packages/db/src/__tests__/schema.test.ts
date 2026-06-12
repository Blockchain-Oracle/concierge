import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  agents,
  attestations,
  eoaTxQueue,
  executions,
  proposals,
  sessionKeys,
  ticks,
} from '../schema/index.ts';

function columnsByName(
  table: ReturnType<typeof getTableConfig>['columns'],
): Record<string, ReturnType<typeof getTableConfig>['columns'][number]> {
  const out: Record<string, ReturnType<typeof getTableConfig>['columns'][number]> = {};
  for (const c of table) out[c.name] = c;
  return out;
}

describe('agents schema', () => {
  const cfg = getTableConfig(agents);
  const cols = columnsByName(cfg.columns);

  it('has all spec columns', () => {
    for (const name of [
      'id',
      'user_id',
      'smart_account_addr',
      'erc8004_agent_id',
      'owner_eoa',
      'policy_json',
      'goal_json',
      'chain',
      'activated_at',
      'paused_at',
      'created_at',
    ]) {
      expect(cols[name], `missing column ${name}`).toBeDefined();
    }
  });

  it('id is the primary key', () => {
    expect(cols['id']?.primary).toBe(true);
  });

  it('paused_at is nullable (pausable agent)', () => {
    expect(cols['paused_at']?.notNull).toBe(false);
  });

  it('user_id, smart_account_addr, owner_eoa, policy_json, goal_json, chain are NOT NULL', () => {
    for (const name of [
      'user_id',
      'smart_account_addr',
      'owner_eoa',
      'policy_json',
      'goal_json',
      'chain',
    ]) {
      expect(cols[name]?.notNull, `${name} should be NOT NULL`).toBe(true);
    }
  });
});

describe('ticks schema — FK to agents', () => {
  const cfg = getTableConfig(ticks);
  it('has agent_id FK with ON DELETE CASCADE', () => {
    const fk = cfg.foreignKeys[0];
    expect(fk, 'missing foreign key').toBeDefined();
    const ref = fk?.reference();
    expect(ref?.foreignTable).toBe(agents);
    expect(fk?.onDelete).toBe('cascade');
  });
});

describe('proposals schema — unique-pending invariant', () => {
  const cfg = getTableConfig(proposals);
  const cols = columnsByName(cfg.columns);

  it('has FKs to both agents AND ticks with cascade', () => {
    const refTables = cfg.foreignKeys.map((fk) => fk.reference().foreignTable);
    expect(refTables).toContain(agents);
    expect(refTables).toContain(ticks);
    for (const fk of cfg.foreignKeys) expect(fk.onDelete).toBe('cascade');
  });

  it('amount_usd is numeric with 30,8 precision (no float drift)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const amount = cols['amount_usd'] as any;
    expect(amount?.columnType).toBe('PgNumeric');
    expect(amount?.precision).toBe(30);
    expect(amount?.scale).toBe(8);
  });

  it('has a partial unique index on (agent_id) WHERE status = pending', () => {
    const idx = cfg.indexes.find((i) => i.config.name === 'proposals_one_pending_per_agent');
    expect(idx, 'missing unique index').toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where, 'partial WHERE clause missing').toBeDefined();
    // Assert the WHERE clause actually filters on status='pending' — without this
    // a typo like `status = 'Pending'` would pass the structural assertion.
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle SQL chunks
    const whereChunks = ((idx?.config.where as any)?.queryChunks ?? []) as unknown[];
    const literals = whereChunks
      .filter((c) => typeof c === 'object' && c !== null && 'value' in c)
      // biome-ignore lint/suspicious/noExplicitAny: extracting literal values from SQL chunks
      .map((c) => (c as any).value);
    expect(literals.flat().join(' ')).toContain("'pending'");
  });

  it('has CHECK constraints rejecting NaN/negative amount_usd and expires_at <= created_at', () => {
    const checkNames = cfg.checks.map((c) => c.name);
    expect(checkNames).toContain('proposals_amount_usd_finite_nonneg');
    expect(checkNames).toContain('proposals_expires_after_created');
  });
});

describe('executions schema — links proposal to attestation', () => {
  const cfg = getTableConfig(executions);
  const cols = columnsByName(cfg.columns);

  it('has FK to proposals with cascade', () => {
    const fk = cfg.foreignKeys[0];
    expect(fk?.reference().foreignTable).toBe(proposals);
    expect(fk?.onDelete).toBe('cascade');
  });

  it('attestation_uid and attestation_tx_hash are nullable (filled by record() phase)', () => {
    expect(cols['attestation_uid']?.notNull).toBe(false);
    expect(cols['attestation_tx_hash']?.notNull).toBe(false);
  });

  it('block_number and gas_used are bigint columns', () => {
    expect(cols['block_number']?.dataType).toBe('bigint');
    expect(cols['gas_used']?.dataType).toBe('bigint');
  });
});

describe('attestations schema — UID is PK, no agent FK', () => {
  const cfg = getTableConfig(attestations);
  const cols = columnsByName(cfg.columns);

  it('uid is the primary key', () => {
    expect(cols['uid']?.primary).toBe(true);
  });

  it('has NO foreign key on agent_id (attestations outlive local agent records)', () => {
    expect(cfg.foreignKeys).toHaveLength(0);
  });
});

describe('session_keys schema — encrypted_private_key MUST be bytea', () => {
  const cfg = getTableConfig(sessionKeys);
  const cols = columnsByName(cfg.columns);

  it('encrypted_private_key column data type is bytea (NOT text — prevents charset corruption)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const col = cols['encrypted_private_key'] as any;
    expect(col).toBeDefined();
    // Custom-typed column reports its SQL type via getSQLType()
    expect(col?.getSQLType?.()).toBe('bytea');
  });

  it('has FK to agents with cascade', () => {
    const fk = cfg.foreignKeys[0];
    expect(fk?.reference().foreignTable).toBe(agents);
    expect(fk?.onDelete).toBe('cascade');
  });

  it('revoked_at is nullable (key is live until explicitly revoked)', () => {
    expect(cols['revoked_at']?.notNull).toBe(false);
  });
});

describe('eoa_tx_queue schema — fallback queue', () => {
  const cfg = getTableConfig(eoaTxQueue);
  const cols = columnsByName(cfg.columns);

  it('has FK to agents with cascade', () => {
    const fk = cfg.foreignKeys[0];
    expect(fk?.reference().foreignTable).toBe(agents);
    expect(fk?.onDelete).toBe('cascade');
  });

  it('signed_tx, tx_hash, block_number, error are nullable (filled across lifecycle)', () => {
    for (const name of ['signed_tx', 'tx_hash', 'block_number', 'error']) {
      expect(cols[name]?.notNull, `${name} should be nullable`).toBe(false);
    }
  });

  it('value column is text (wei does not fit JS Number; numeric is wasteful)', () => {
    expect(cols['value']?.dataType).toBe('string');
  });

  it('has CHECK constraints on value (uint256 string), to (address), data (hex)', () => {
    const checkNames = cfg.checks.map((c) => c.name);
    expect(checkNames).toContain('eoa_tx_queue_value_uint256');
    expect(checkNames).toContain('eoa_tx_queue_to_is_address');
    expect(checkNames).toContain('eoa_tx_queue_data_is_hex');
  });
});

describe('enum-backed status columns — DB-enforced literal sets', () => {
  it('agents.chain uses pgEnum (NOT compile-time-only $type narrowing)', () => {
    const cfg = getTableConfig(agents);
    const cols = columnsByName(cfg.columns);
    // pgEnum-backed columns report enumValues; $type<T> narrowed columns do not.
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const chain = cols['chain'] as any;
    expect(chain?.enumValues).toEqual(['mantle-mainnet', 'mantle-sepolia']);
  });

  it('ticks.status uses pgEnum', () => {
    const cfg = getTableConfig(ticks);
    const cols = columnsByName(cfg.columns);
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const status = cols['status'] as any;
    expect(status?.enumValues).toEqual([
      'noop',
      'awaiting_approval',
      'awaiting_signature',
      'executed',
      'failed',
    ]);
  });

  it('proposals.status uses pgEnum', () => {
    const cfg = getTableConfig(proposals);
    const cols = columnsByName(cfg.columns);
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const status = cols['status'] as any;
    expect(status?.enumValues).toEqual(['pending', 'approved', 'rejected', 'expired']);
  });

  it('executions.status uses pgEnum', () => {
    const cfg = getTableConfig(executions);
    const cols = columnsByName(cfg.columns);
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const status = cols['status'] as any;
    expect(status?.enumValues).toEqual(['submitted', 'confirmed', 'failed']);
  });

  it('eoaTxQueue.status uses pgEnum', () => {
    const cfg = getTableConfig(eoaTxQueue);
    const cols = columnsByName(cfg.columns);
    // biome-ignore lint/suspicious/noExplicitAny: probing Drizzle column internals
    const status = cols['status'] as any;
    expect(status?.enumValues).toEqual(['pending', 'signed', 'confirmed', 'failed']);
  });
});
