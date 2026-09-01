import { createHash, randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";

const required = [
  "APP_BASE_URL",
  "AUTH_BASE_URL",
  "AUTH_SECRET",
  "CRON_SECRET",
  "API_KEY_PEPPER",
  "API_KEY_PEPPER_VERSION",
  "DATABASE_URL",
  "IDENTITY_DIGEST_PEPPER",
  "IDENTITY_DIGEST_VERSION",
  "EMAIL_FROM",
  "KNOT_ALLOWED_EMAILS",
  "RESEND_API_KEY",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];

for (const name of required) {
  if (!process.env[name] || process.env[name] === "[SENSITIVE]") {
    throw new Error(`${name} is required`);
  }
}
validateContentOrigin(process.env.APP_BASE_URL, process.env.CONTENT_BASE_URL);
if (
  !["postgres", "upstash"].includes(
    process.env.REPLAY_STORE_DRIVER ?? "postgres",
  )
) {
  throw new Error("REPLAY_STORE_DRIVER must be postgres or legacy upstash");
}
if (
  (process.env.CONNECTOR_RATE_LIMIT_STORE_DRIVER ?? "upstash") !== "upstash"
) {
  throw new Error(
    "CONNECTOR_RATE_LIMIT_STORE_DRIVER must be upstash for this deployment",
  );
}

const explicitUpstash =
  hasEnvironmentValue("UPSTASH_REDIS_REST_URL") ||
  hasEnvironmentValue("UPSTASH_REDIS_REST_TOKEN");
const redisUrl = requiredEnvironmentValue(
  explicitUpstash ? "UPSTASH_REDIS_REST_URL" : "KV_REST_API_URL",
);
const redisToken = requiredEnvironmentValue(
  explicitUpstash ? "UPSTASH_REDIS_REST_TOKEN" : "KV_REST_API_TOKEN",
);

const database = neon(process.env.DATABASE_URL);
const roles = await database`
  SELECT
    current_user AS role_name,
    current_setting('is_superuser') = 'on' AS is_superuser,
    rolbypassrls AS bypasses_rls,
    rolcreatedb AS can_create_database,
    rolcreaterole AS can_create_role,
    rolinherit AS inherits_roles,
    EXISTS (
      SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid
    ) AS has_role_membership
  FROM pg_roles
  WHERE rolname = current_user
`;
const role = roles[0];
if (
  !role ||
  role.role_name !== "knot_app" ||
  role.is_superuser ||
  role.bypasses_rls ||
  role.can_create_database ||
  role.can_create_role ||
  role.inherits_roles ||
  role.has_role_membership
) {
  throw new Error("DATABASE_URL is not using the restricted knot_app role");
}

const commandProcedures = await database`
  SELECT
    to_regprocedure(
      'claim_command(uuid,uuid,scope_name[],timestamp with time zone,text,integer)'
    ) IS NOT NULL AS claim_command,
    to_regprocedure(
      'extend_command_lease(uuid,uuid,uuid,integer,timestamp with time zone,text,integer)'
    ) IS NOT NULL AS extend_command_lease,
    to_regprocedure(
      'complete_command(uuid,uuid,uuid,integer,timestamp with time zone,text,command_state,jsonb,text,boolean,integer)'
    ) IS NOT NULL AS complete_command
`;
const commandProcedure = commandProcedures[0];
if (
  !commandProcedure?.claim_command ||
  !commandProcedure.extend_command_lease ||
  !commandProcedure.complete_command
) {
  throw new Error(
    "The exact command-ledger procedure signatures from migration 0007 are required",
  );
}

const replayProcedures = await database`
  SELECT to_regprocedure(
    'claim_connector_request_nonce(uuid,uuid,text,timestamp with time zone)'
  ) IS NOT NULL AS durable_nonce_claim
`;
if (!replayProcedures[0]?.durable_nonce_claim) {
  throw new Error("The durable Postgres connector nonce procedure is required");
}

const redis = new Redis({
  url: redisUrl,
  token: redisToken,
});
if ((await redis.ping()) !== "PONG") {
  throw new Error("Upstash did not answer PING with PONG");
}

const bucket = process.env.R2_BUCKET_NAME;
const expected = new TextEncoder().encode("knot-cloud-provider-smoke-test");
const tenantId = randomUUID();
const sha256 = createHash("sha256").update(expected).digest("hex");
const key = `tenants/${tenantId}/assets/${sha256.slice(0, 2)}/${sha256}`;
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  // Keep the smoke request identical to the runtime adapter: R2 accepts the
  // explicit Content-MD5, but rejects an additional optional SDK checksum.
  requestChecksumCalculation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

let uploaded = false;
let operationFailed = false;
try {
  await r2.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: expected,
      CacheControl: "private, no-store, max-age=0",
      ContentLength: expected.byteLength,
      ContentMD5: createHash("md5").update(expected).digest("base64"),
      ContentType: "text/plain",
      Metadata: {
        "byte-size": String(expected.byteLength),
        kind: "asset",
        sha256,
        "tenant-id": tenantId,
      },
      IfNoneMatch: "*",
    }),
  );
  uploaded = true;
  const stored = await r2.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
  const actual = await stored.Body?.transformToByteArray();
  if (
    !actual ||
    Buffer.compare(Buffer.from(actual), Buffer.from(expected)) !== 0
  ) {
    throw new Error("R2 smoke object did not round-trip exactly");
  }
  if (
    stored.Metadata?.sha256 !== sha256 ||
    stored.Metadata?.["tenant-id"] !== tenantId ||
    stored.Metadata?.kind !== "asset" ||
    stored.CacheControl !== "private, no-store, max-age=0"
  ) {
    throw new Error("R2 smoke object metadata did not round-trip exactly");
  }
} catch (error) {
  operationFailed = true;
  throw error;
} finally {
  try {
    if (uploaded) {
      await r2.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  } catch (cleanupError) {
    if (!operationFailed) throw cleanupError;
    console.error("R2 smoke cleanup also failed after the primary failure.");
  } finally {
    r2.destroy();
  }
}

console.log(
  "Neon role, command and durable nonce procedures, Upstash rate limiting, and R2 object round-trip verified.",
);

function hasEnvironmentValue(name) {
  return (
    typeof process.env[name] === "string" && process.env[name].trim() !== ""
  );
}

function requiredEnvironmentValue(name) {
  const value = process.env[name];
  if (!value || value === "[SENSITIVE]") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateContentOrigin(applicationValue, contentValue) {
  if (!contentValue || contentValue.trim() === "") return;
  const application = new URL(applicationValue);
  const content = new URL(contentValue);
  if (
    content.username ||
    content.password ||
    content.pathname !== "/" ||
    content.search ||
    content.hash ||
    content.protocol !== "https:"
  ) {
    throw new Error("CONTENT_BASE_URL must be a bare HTTPS origin");
  }
  if (
    content.origin === application.origin ||
    registrableApproximation(content.hostname) ===
      registrableApproximation(application.hostname)
  ) {
    throw new Error(
      "CONTENT_BASE_URL must use a separate registrable domain from APP_BASE_URL",
    );
  }
}

function registrableApproximation(hostname) {
  return hostname.toLowerCase().split(".").filter(Boolean).slice(-2).join(".");
}
