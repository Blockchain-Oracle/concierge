import { describe, expect, it, vi } from 'vitest';
import { type ConciergeConfig, ConfigSchema, loadConfig } from '../config.ts';
import { ConfigError } from '../errors.ts';

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test-xxxxxxxxxxxxxxxxxxxx',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/concierge',
  REDIS_URL: 'redis://localhost:6379',
  MANTLE_RPC_URL: 'https://rpc.mantle.xyz',
  MANTLE_SEPOLIA_RPC_URL: 'https://rpc.sepolia.mantle.xyz',
  MANTLE_CHAIN_ID: '5000',
  NODE_ENV: 'test',
} as const;

describe('loadConfig — happy path (story-24)', () => {
  it('returns typed config with camelCase keys', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.anthropicApiKey).toBe(VALID_ENV.ANTHROPIC_API_KEY);
    expect(config.databaseUrl).toBe(VALID_ENV.DATABASE_URL);
    expect(config.redisUrl).toBe(VALID_ENV.REDIS_URL);
    expect(config.mantleRpcUrl).toBe(VALID_ENV.MANTLE_RPC_URL);
    expect(config.mantleChainId).toBe(5000);
  });

  it('MANTLE_CHAIN_ID string → number (coercion)', () => {
    const config = loadConfig({ ...VALID_ENV, MANTLE_CHAIN_ID: '5000' });
    expect(typeof config.mantleChainId).toBe('number');
    expect(config.mantleChainId).toBe(5000);
  });

  it('accepts MANTLE_CHAIN_ID 5003 (Sepolia) when MANTLE_RPC_URL is the Sepolia endpoint', () => {
    // Sepolia chain ID requires a matching RPC URL — the superRefine guard rejects
    // MANTLE_CHAIN_ID=5003 + the mainnet RPC default to prevent silent misconfiguration.
    const config = loadConfig({
      ...VALID_ENV,
      MANTLE_CHAIN_ID: '5003',
      MANTLE_RPC_URL: 'https://rpc.sepolia.mantle.xyz',
    });
    expect(config.mantleChainId).toBe(5003);
    expect(config.mantleRpcUrl).toBe('https://rpc.sepolia.mantle.xyz');
  });

  it('optional vars are undefined when absent', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.zeroDevProjectId).toBeUndefined();
    expect(config.pimlicoApiKey).toBeUndefined();
    expect(config.lifiApiKey).toBeUndefined();
    expect(config.sentryDsn).toBeUndefined();
  });

  it('optional vars are forwarded when present', () => {
    const config = loadConfig({
      ...VALID_ENV,
      ZERODEV_PROJECT_ID: 'zd-123',
      LIFI_API_KEY: 'lifi-abc',
    });
    expect(config.zeroDevProjectId).toBe('zd-123');
    expect(config.lifiApiKey).toBe('lifi-abc');
  });

  it('SENTRY_DSN valid URL is forwarded', () => {
    const config = loadConfig({ ...VALID_ENV, SENTRY_DSN: 'https://abc@sentry.io/123' });
    expect(config.sentryDsn).toBe('https://abc@sentry.io/123');
  });
});

describe('loadConfig — defaults (story-24)', () => {
  it('MANTLE_RPC_URL defaults when omitted', () => {
    const { MANTLE_RPC_URL: _, ...rest } = VALID_ENV;
    expect(loadConfig({ ...rest }).mantleRpcUrl).toBe('https://rpc.mantle.xyz');
  });

  it('MANTLE_SEPOLIA_RPC_URL defaults when omitted', () => {
    const { MANTLE_SEPOLIA_RPC_URL: _, ...rest } = VALID_ENV;
    expect(loadConfig({ ...rest }).mantleSepoliaRpcUrl).toBe('https://rpc.sepolia.mantle.xyz');
  });

  it('NODE_ENV defaults to "development" when omitted', () => {
    const { NODE_ENV: _, ...rest } = VALID_ENV;
    expect(loadConfig({ ...rest }).nodeEnv).toBe('development');
  });

  it('zero-arg form uses process.env — throws ConfigError when required vars absent', () => {
    // Stub away a required var to guarantee the throw regardless of the developer
    // environment or CI secrets. Without this, the test is flaky: any machine
    // with a fully configured env would see loadConfig() succeed and the test fail.
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    try {
      expect(() => loadConfig()).toThrow(ConfigError);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('loadConfig — required field failures (story-24)', () => {
  it('missing ANTHROPIC_API_KEY throws ConfigError', () => {
    const { ANTHROPIC_API_KEY: _, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
  });

  it('missing DATABASE_URL throws ConfigError', () => {
    const { DATABASE_URL: _, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
  });

  it('missing REDIS_URL throws ConfigError', () => {
    const { REDIS_URL: _, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
  });

  it('missing MANTLE_CHAIN_ID throws ConfigError', () => {
    const { MANTLE_CHAIN_ID: _, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
  });

  it('MANTLE_CHAIN_ID 999 (invalid) throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, MANTLE_CHAIN_ID: '999' })).toThrow(ConfigError);
  });

  it('MANTLE_CHAIN_ID empty string throws ConfigError (coerces to 0, fails refine)', () => {
    expect(() => loadConfig({ ...VALID_ENV, MANTLE_CHAIN_ID: '' })).toThrow(ConfigError);
  });

  it('MANTLE_CHAIN_ID non-numeric string throws ConfigError (coerces to NaN, fails refine)', () => {
    expect(() => loadConfig({ ...VALID_ENV, MANTLE_CHAIN_ID: 'abc' })).toThrow(ConfigError);
  });

  it('MANTLE_CHAIN_ID=5003 with mainnet MANTLE_RPC_URL throws ConfigError (cross-field guard)', () => {
    // Sepolia chain ID + mainnet RPC URL is a silent misconfiguration trap: the schema
    // catches it explicitly rather than letting transactions route to the wrong chain.
    expect(() => loadConfig({ ...VALID_ENV, MANTLE_CHAIN_ID: '5003' })).toThrow(ConfigError);
  });

  it('DATABASE_URL non-URL throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, DATABASE_URL: 'not-a-url' })).toThrow(ConfigError);
  });

  it('MANTLE_RPC_URL non-URL throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, MANTLE_RPC_URL: 'not-a-url' })).toThrow(ConfigError);
  });
});

describe('loadConfig — ANTHROPIC_API_KEY validation (story-24)', () => {
  it('ANTHROPIC_API_KEY without sk-ant- prefix throws ConfigError', () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: 'sk-openai-wrong-prefix-xx' }),
    ).toThrow(ConfigError);
  });

  it('ANTHROPIC_API_KEY correct prefix but too short (< 20 chars) throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: 'sk-ant-x' })).toThrow(ConfigError);
  });

  it('ANTHROPIC_API_KEY empty string throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, ANTHROPIC_API_KEY: '' })).toThrow(ConfigError);
  });

  it('DATABASE_URL empty string throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, DATABASE_URL: '' })).toThrow(ConfigError);
  });

  it('NODE_ENV invalid value (e.g. "staging") throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});

describe('loadConfig — optional field edge cases (story-24)', () => {
  it('SENTRY_DSN non-URL string throws ConfigError', () => {
    expect(() => loadConfig({ ...VALID_ENV, SENTRY_DSN: 'sentry-placeholder' })).toThrow(
      ConfigError,
    );
  });

  it('SENTRY_DSN empty string treated as absent — does NOT throw', () => {
    expect(() => loadConfig({ ...VALID_ENV, SENTRY_DSN: '' })).not.toThrow();
    expect(loadConfig({ ...VALID_ENV, SENTRY_DSN: '' }).sentryDsn).toBeUndefined();
  });

  it('SENTRY_DSN whitespace-only treated as absent — does NOT throw (k8s ConfigMap idiom)', () => {
    // Docker / k8s ConfigMap may inject " " rather than "" when a value is blank.
    // The trim() in the schema transform must cover this case, not just strict "".
    expect(() => loadConfig({ ...VALID_ENV, SENTRY_DSN: '   ' })).not.toThrow();
    expect(loadConfig({ ...VALID_ENV, SENTRY_DSN: '   ' }).sentryDsn).toBeUndefined();
  });

  it('ZERODEV_PROJECT_ID empty string throws ConfigError (blank credential rejected)', () => {
    expect(() => loadConfig({ ...VALID_ENV, ZERODEV_PROJECT_ID: '' })).toThrow(ConfigError);
  });
});

describe('loadConfig — ConfigError shape (story-24)', () => {
  it('thrown error has type "ConfigError" and includes field name in message', () => {
    const { DATABASE_URL: _, ...rest } = VALID_ENV;
    expect(() => loadConfig({ ...rest })).toThrow(ConfigError);
    try {
      loadConfig({ ...rest });
      expect.fail('should have thrown');
    } catch (err) {
      const e = err as ConfigError;
      expect(e.type).toBe('ConfigError');
      expect(e.message).toContain('DATABASE_URL');
    }
  });

  it('thrown error carries typed metadata with Zod issues array', () => {
    const { DATABASE_URL: _, ...rest } = VALID_ENV;
    try {
      loadConfig({ ...rest });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const meta = (err as ConfigError).metadata;
      expect(meta).toBeDefined();
      expect(Array.isArray(meta?.issues)).toBe(true);
      expect(meta?.issues.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('forwarding test for remaining optional fields (pinataJwt, web3StorageToken, privyAppId, privyServerKey)', () => {
    const config = loadConfig({
      ...VALID_ENV,
      PINATA_JWT: 'pinata-jwt-token',
      WEB3_STORAGE_TOKEN: 'w3s-token',
      PRIVY_APP_ID: 'privy-app-123',
      PRIVY_SERVER_KEY: 'privy-key-abc',
    });
    expect(config.pinataJwt).toBe('pinata-jwt-token');
    expect(config.web3StorageToken).toBe('w3s-token');
    expect(config.privyAppId).toBe('privy-app-123');
    expect(config.privyServerKey).toBe('privy-key-abc');
  });
});

describe('ConfigSchema (story-24)', () => {
  it('parses valid env successfully', () => {
    const result = ConfigSchema.safeParse({ ...VALID_ENV });
    expect(result.success).toBe(true);
  });

  it('returns issues on invalid input', () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });

  it('ConciergeConfig type is assignable from loadConfig return (compile-time check)', () => {
    const _config: ConciergeConfig = loadConfig({ ...VALID_ENV });
    expect(_config.anthropicApiKey).toBeDefined();
  });
});
