CREATE TYPE "public"."agent_chain" AS ENUM('mantle-mainnet', 'mantle-sepolia');--> statement-breakpoint
CREATE TYPE "public"."eoa_tx_status" AS ENUM('pending', 'signed', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('submitted', 'confirmed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."tick_status" AS ENUM('noop', 'awaiting_approval', 'awaiting_signature', 'executed', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"smart_account_addr" text NOT NULL,
	"erc8004_agent_id" bigint,
	"owner_eoa" text NOT NULL,
	"policy_json" jsonb NOT NULL,
	"goal_json" jsonb NOT NULL,
	"chain" "agent_chain" NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"paused_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attestations" (
	"uid" text PRIMARY KEY NOT NULL,
	"schema_uid" text NOT NULL,
	"agent_id" text NOT NULL,
	"payload_json" jsonb NOT NULL,
	"tx_hash" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "eoa_tx_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"to" text NOT NULL,
	"data" text NOT NULL,
	"value" text NOT NULL,
	"status" "eoa_tx_status" NOT NULL,
	"signed_tx" text,
	"tx_hash" text,
	"block_number" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eoa_tx_queue_value_uint256" CHECK ("eoa_tx_queue"."value" ~ '^[0-9]+$' AND length("eoa_tx_queue"."value") <= 78),
	CONSTRAINT "eoa_tx_queue_to_is_address" CHECK ("eoa_tx_queue"."to" ~ '^0x[0-9a-fA-F]{40}$'),
	CONSTRAINT "eoa_tx_queue_data_is_hex" CHECK ("eoa_tx_queue"."data" ~ '^0x[0-9a-fA-F]*$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposal_id" uuid NOT NULL,
	"tx_hash" text NOT NULL,
	"block_number" bigint,
	"gas_used" bigint,
	"attestation_uid" text,
	"attestation_tx_hash" text,
	"status" "execution_status" NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"tick_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_usd" numeric(30, 8) NOT NULL,
	"protocol" text NOT NULL,
	"plan_json" jsonb NOT NULL,
	"sim_json" jsonb NOT NULL,
	"status" "proposal_status" NOT NULL,
	"requires_approval" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "proposals_amount_usd_finite_nonneg" CHECK ("proposals"."amount_usd" = "proposals"."amount_usd" AND "proposals"."amount_usd" >= 0),
	CONSTRAINT "proposals_expires_after_created" CHECK ("proposals"."expires_at" > "proposals"."created_at")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"public_address" text NOT NULL,
	"encrypted_private_key" "bytea" NOT NULL,
	"policy_json" jsonb NOT NULL,
	"signature" text NOT NULL,
	"valid_until" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"phase" text NOT NULL,
	"status" "tick_status" NOT NULL,
	"payload_json" jsonb NOT NULL,
	"duration_ms" bigint,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "eoa_tx_queue" ADD CONSTRAINT "eoa_tx_queue_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "executions" ADD CONSTRAINT "executions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "proposals" ADD CONSTRAINT "proposals_tick_id_ticks_id_fk" FOREIGN KEY ("tick_id") REFERENCES "public"."ticks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_keys" ADD CONSTRAINT "session_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ticks" ADD CONSTRAINT "ticks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "proposals_one_pending_per_agent" ON "proposals" USING btree ("agent_id") WHERE "proposals"."status" = 'pending';