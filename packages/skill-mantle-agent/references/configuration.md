# Configuration — Concierge Mantle Agent

The skill reads `~/.concierge/config.json` at startup. This document covers
every field, default, and override.

## Config file shape

```json
{
  "userId": "user_…",
  "url": "https://concierge.xyz",
  "chain": "mantle",
  "createdAt": "2026-06-13T12:00:00Z",
  "defaults": {
    "maxSlippageBps": 50,
    "minHealthFactor": 1.5,
    "maxTickSpendUsd": 100
  }
}
```

All fields under `defaults` are optional — the agent uses the values below
when absent.

## Fields

### `userId` (required)

Your `concierge.xyz` account id. Written by the post-install script. Used to
look up your agent + session keys on every MCP tool call.

### `url` (default: `https://concierge.xyz`)

The Concierge backend URL. Override via the `CONCIERGE_URL` env var when
running against a staging deployment.

### `chain` (default: `mantle`)

Which chain the agent operates on. Supported values:

| Value           | Chain ID | Notes                                          |
|-----------------|---------:|------------------------------------------------|
| `mantle`        |   5000   | Mainnet. Real funds. Default.                  |
| `mantle-sepolia`|   5003   | Testnet. Mock Aave V3 + faucet for safe demos. |

### `defaults.maxSlippageBps` (default: `50`, i.e. 0.5%)

Default max slippage for DEX swaps initiated by the tick loop. Per-tick
overrides via the dashboard. Above 200 bps, the agent asks for confirmation
before executing.

### `defaults.minHealthFactor` (default: `1.5`)

Minimum Aave V3 health factor the agent maintains. The tick loop will refuse
to take any action that would bring HF below this threshold; emergency-stop
fires if HF crosses 1.1 from external moves.

### `defaults.maxTickSpendUsd` (default: `100`)

Per-tick gas + protocol-fee cap. Above this, the tick proposes the action but
does NOT execute — you confirm via the dashboard. Stops a runaway loop from
draining gas.

## Per-protocol settings

Per-protocol thresholds (Aave LTV targets, sUSDe carry target, etc.) live on
the backend, not in this local config. Edit them at
`https://concierge.xyz/dashboard` → "Strategy".

## Environment variables

| Var                | Purpose                                            |
|--------------------|----------------------------------------------------|
| `CONCIERGE_URL`    | Override the backend URL (staging / local dev).    |
| `CONCIERGE_CONFIG` | Override the config file path (default `~/.concierge/config.json`). |

## Reset

To start fresh:

```bash
rm ~/.concierge/config.json
./scripts/install.sh
```

The configurator will re-run the OAuth flow.
