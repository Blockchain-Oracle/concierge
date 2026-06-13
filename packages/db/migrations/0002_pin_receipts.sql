-- story-81 pin_receipts: audit table for IPFS pinning attempts.
-- Round-1: persists BOTH service CIDs + cidDivergence flag + notConfigured
-- discriminator; tighter CID regex (CIDv1 base32 OR CIDv0 base58btc).
CREATE TABLE IF NOT EXISTS "pin_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cid" text NOT NULL,
  "agent_id" text NOT NULL,
  "hash" text NOT NULL,
  "cid_divergence" boolean NOT NULL DEFAULT false,
  "primary_service" text NOT NULL,
  "primary_cid" text,
  "primary_pin_id" text,
  "primary_ok" boolean NOT NULL,
  "primary_error" text,
  "primary_not_configured" boolean NOT NULL DEFAULT false,
  "fallback_service" text NOT NULL,
  "fallback_cid" text,
  "fallback_pin_id" text,
  "fallback_ok" boolean NOT NULL,
  "fallback_error" text,
  "fallback_not_configured" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "pin_receipts_cid_shape" CHECK ("cid" ~ '^bafy[a-z2-7]{52,}$' OR "cid" ~ '^Qm[1-9A-HJ-NP-Za-km-z]{44}$'),
  CONSTRAINT "pin_receipts_agent_id_uint256" CHECK ("agent_id" ~ '^[0-9]+$'),
  CONSTRAINT "pin_receipts_hash_bytes32" CHECK ("hash" ~ '^0x[0-9a-fA-F]{64}$'),
  CONSTRAINT "pin_receipts_at_least_one_ok" CHECK ("primary_ok" = true OR "fallback_ok" = true)
);

CREATE INDEX IF NOT EXISTS "idx_pin_receipts_cid" ON "pin_receipts" ("cid");
CREATE INDEX IF NOT EXISTS "idx_pin_receipts_agent_id" ON "pin_receipts" ("agent_id");
CREATE INDEX IF NOT EXISTS "idx_pin_receipts_created_at" ON "pin_receipts" ("created_at");
CREATE INDEX IF NOT EXISTS "idx_pin_receipts_agent_created" ON "pin_receipts" ("agent_id", "created_at" DESC);
