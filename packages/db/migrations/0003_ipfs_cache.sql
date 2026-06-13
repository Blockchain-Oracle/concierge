-- story-84 ipfs_cache: durable cache of IPFS-fetched envelope payloads.
-- Content is content-addressed (immutable), so a 30-day TTL is safe.
-- 1MB content cap prevents unbounded growth from malformed gateway responses.
CREATE TABLE IF NOT EXISTS "ipfs_cache" (
  "cid" text PRIMARY KEY NOT NULL,
  "content" text NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ipfs_cache_cid_shape" CHECK ("cid" ~ '^ba[a-z2-7]{56,256}$' OR "cid" ~ '^Qm[1-9A-HJ-NP-Za-km-z]{44}$'),
  CONSTRAINT "ipfs_cache_content_size" CHECK (length("content") <= 1048576)
);

CREATE INDEX IF NOT EXISTS "idx_ipfs_cache_last_accessed" ON "ipfs_cache" ("last_accessed_at");
