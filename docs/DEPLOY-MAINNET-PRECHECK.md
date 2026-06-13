# Mainnet Deploy Precheck — Sign-Off Checklist

Complete and screenshot this checklist to the deploys channel BEFORE the
driver runs the deploy command. Two signatures required (driver + observer).

> Date: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_
> Driver: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_  Observer: \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

## Pre-conditions

- [ ] **CI green on main.** `gh run list --branch main --limit 1 --json conclusion` returns `success`.
- [ ] **Audit findings closed.** Every CRITICAL and HIGH item in `research/concierge/AUDIT-*.md` has either a merged fix PR or an explicit sign-off in this checklist with rationale.
- [ ] **It is NOT a Friday.** Today is one of: Mon/Tue/Wed/Thu. (Avoid weekend exposure with no support coverage.)
- [ ] **Working tree clean.** `git status` shows no uncommitted changes.
- [ ] **On main, not a feature branch.** `git rev-parse --abbrev-ref HEAD` returns `main`.

## Security hardening

- [ ] **NEVER `curl ... | bash`** any deploy step. Always: clone the repo,
      checksum the script (`shasum -a 256 scripts/preflight-mainnet.sh`),
      visually review the diff vs main, THEN run with explicit `bash <path>`.
      Pipe-to-shell removes the review step that catches typosquats /
      compromised mirrors.
- [ ] **Prefer Foundry encrypted keystore over `OPS_PRIVATE_KEY` env**
      (CWE-214 — `--private-key` in argv leaks via `ps auxe` and
      `/proc/<pid>/cmdline`). Set up with:
      ```bash
      cast wallet new                       # creates keystore at ~/.foundry/keystores/
      forge script ... --account ops-mainnet --sender 0x...
      ```
      The env-var path is supported for legacy compatibility but produces
      a loud WARNING in the preflight log.

## Environment

- [ ] `MANTLE_RPC_URL` is set to `https://rpc.mantle.xyz` (not a fork / proxy).
- [ ] `OPS_PRIVATE_KEY` is the OPS multisig signer key, NOT a developer key.
- [ ] `MANTLESCAN_API_KEY` is set and valid (test: `curl "https://api.mantlescan.xyz/api?module=stats&action=ethsupply&apikey=$MANTLESCAN_API_KEY"` returns `status:"1"`).
- [ ] Deployer EOA address matches the intended OPS signer:
      `cast wallet address --private-key "$OPS_PRIVATE_KEY"` →
      \_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_\_

## Balance + gas

- [ ] Deployer MNT balance ≥ 0.5: \_\_\_\_\_\_\_\_\_\_ MNT (observed).
- [ ] Current gas price ≤ 0.5 gwei: \_\_\_\_\_\_\_\_\_\_ gwei (observed).
- [ ] Preflight script exits 0:
      ```bash
      bash scripts/preflight-mainnet.sh
      ```

## Code

- [ ] `contracts/script/DeployAll.s.sol` reviewed by **second pair of eyes** (sign here: \_\_\_\_\_\_\_\_\_).
- [ ] Chain-id guard in DeployAll.s.sol asserts `block.chainid == 5000`.
- [ ] `packages/shared/src/addresses.ts` has `mantleMainnet.conciergeRegistry` set to a ZERO_ADDRESS placeholder (post-deploy publication will replace it).

## Network

- [ ] You are NOT on a VPN that routes through an untrusted exit (verify `curl -s ifconfig.me` matches your expected egress).
- [ ] `rpc.mantle.xyz` is reachable from your terminal:
      `cast chain-id --rpc-url "$MANTLE_RPC_URL"` returns `5000`.

## Rollback readiness

- [ ] [`DEPLOY-MAINNET-ROLLBACK.md`](./DEPLOY-MAINNET-ROLLBACK.md) read in full.
- [ ] You know who has the UUPS admin key in case an immediate impl-swap is needed.

## Sign-off

- [ ] **Driver acknowledges**: the broadcast is irreversible; the confirmation prompt requires exact-string `DEPLOY-MAINNET`, NOT y/yes.
- [ ] **Observer acknowledges**: they will read every cast/forge output aloud and FLAG anything unexpected.

---

If any box is unchecked, **STOP**. Do not deploy. The runbook explicitly
states: never deploy without preflight green; never deploy without a second
pair of eyes if money is in play.
