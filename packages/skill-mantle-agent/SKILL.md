---
name: concierge-mantle-agent
description: Autonomous DeFi agent for Mantle. Plans, simulates, executes, and attests positions across Aave V3, Ethena sUSDe, Ondo USDY, mETH staking, Mantle DEXes, and Li.Fi bridging — with ERC-8004 reputation per tick.
version: 0.1.0
homepage: https://concierge.xyz
repository: https://github.com/Blockchain-Oracle/concierge
license: MIT
mcp_server_url: https://mcp.concierge.xyz/mcp
oauth_client_id: concierge-mantle-agent-skill
supported_chains:
  - 5000
  - 5003
tools:
  - name: get_agent_state
    permission: read:agent
    description: Read the agent's current portfolio, open proposals, and tick history.
  - name: get_reputation
    permission: read:agent
    description: Fetch the agent's ERC-8004 reputation track record from chain + IPFS.
  - name: get_attestation
    permission: read:agent
    description: Resolve a specific attestation by hash, returning the canonical envelope.
  - name: pause_agent
    permission: write:agent
    description: Pause the autonomous tick loop. Reads paused after on-chain confirmation.
  - name: resume_agent
    permission: write:agent
    description: Resume the tick loop after a paused state.
  - name: revoke_session_key
    permission: write:agent
    description: Revoke a session key on chain + DB; subsequent UserOps signed by it fail.
permissions:
  - read:agent
  - write:agent
---

# Concierge — Mantle Agent

Concierge is an autonomous AI agent that operates a DeFi portfolio on
[Mantle](https://mantle.xyz). You set a plain-English goal — "earn 8% safely",
"keep my health factor above 1.5", "rebalance every Tuesday" — and Concierge
runs `plan → simulate → propose → execute → record` across seven Mantle
protocols on every tick.

## What it does

- **Aave V3**: supply collateral, borrow against it, repay, manage E-Mode.
- **Ethena sUSDe**: deposit USDC, mint sUSDe, harvest carry.
- **Ondo USDY**: park stablecoins in tokenized US treasuries.
- **mETH**: stake MNT for liquid mETH, claim rewards.
- **Mantle DEXes**: route swaps across Merchant Moe / Agni / FusionX.
- **Li.Fi**: bridge assets between Mantle and other chains.
- **ERC-8004**: every successful tick writes a verifiable attestation, so the
  agent's track record is independently auditable on chain.

## Why a skill

This skill packages Concierge for one-line install in any MCP-enabled client
(Claude Desktop, Cursor, Cline). The skill exposes six tools above; once
installed, you can ask your assistant questions like:

- "What's my current Aave health factor?" → `get_agent_state`
- "Pause my agent before the FOMC announcement." → `pause_agent`
- "Show me the last 10 attestations." → `get_reputation`

## Installation

```bash
npx skills add @concierge/mantle-agent
```

After install, run the post-install configurator to link your Mantle wallet:

```bash
./scripts/install.sh
```

The configurator prompts for your `concierge.xyz` user id (or completes the
OAuth flow) and stores the result in `~/.concierge/config.json`. Subsequent
tool calls authenticate via that config.

## Permissions

- `read:agent` — view portfolio state, reputation, and attestations.
- `write:agent` — control agent lifecycle (pause / resume / revoke session
  key). Write tools require on-chain confirmation; the skill never moves
  funds without an explicit on-chain transaction you've approved.

## See also

- [Quickstart](./references/quickstart.md) — 5-minute tour.
- [Configuration](./references/configuration.md) — chain selection, defaults,
  per-protocol thresholds.
- [concierge.xyz](https://concierge.xyz) — the web app + dashboard.
