# Quickstart — Concierge Mantle Agent (5 minutes)

This walks you from a fresh `npx skills add` to your first agent tick.

## 1. Install the skill

```bash
npx skills add @concierge/mantle-agent
```

The installer drops the skill into your client's skill directory (Claude
Desktop: `~/.claude/skills/`, Cursor: `~/.cursor/skills/`, etc.).

## 2. Link your Mantle wallet

Run the post-install configurator:

```bash
~/.concierge/skill-mantle-agent/scripts/install.sh
```

You'll be prompted for your `concierge.xyz` user id. If you don't have one,
press Enter to open the OAuth flow in your browser and follow the prompts.

The script writes `~/.concierge/config.json` with your account binding. That
file holds your auth token after OAuth completes — keep its 0600 permissions.

## 3. Confirm the MCP server is reachable

In your chat client, ask:

> What's my current agent state?

The skill routes this to the `get_agent_state` tool. A first-time response
looks like:

```
Agent: 0xAGENT…
Chain: Mantle Mainnet (5000)
Tick loop: paused (no session key yet)
Portfolio: empty (deploy a session key via concierge.xyz to begin)
```

If you see a permission error instead, the OAuth flow didn't complete — re-run
the install script.

## 4. Deploy a session key (optional, full ticks)

Read-only tools (`get_agent_state`, `get_reputation`, `get_attestation`) work
without a session key. To unlock pause / resume / revoke, visit
`https://concierge.xyz/dashboard` and issue a session key bound to your EOA.

The session key is **scoped** — it can only call the actions you've allowed
(target contract + selector + spending limit + expiry). The session key never
leaves your wallet's encrypted storage; the skill uses the on-chain validator
to authorize specific UserOps.

## 5. Run your first tick

Visit `https://concierge.xyz/dashboard` → "Start tick loop". Concierge runs
`plan → simulate → propose → execute → record` against your goal. Every
successful tick writes an ERC-8004 attestation to chain — auditable from any
MCP-enabled assistant via `get_reputation`.

## What's next

- Read [`configuration.md`](./configuration.md) for chain selection, default
  thresholds, and per-protocol settings.
- The agent's source + docs live at https://github.com/Blockchain-Oracle/concierge.
- Open issues at https://github.com/Blockchain-Oracle/concierge/issues.
