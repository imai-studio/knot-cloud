import { randomUUID } from "node:crypto";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { neon } from "@neondatabase/serverless";

const required = [
  "APP_BASE_URL",
  "AUTH_BASE_URL",
  "CONTENT_BASE_URL",
  "AUTH_SECRET",
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

const bucket = process.env.R2_BUCKET_NAME;
const key = `smoke/${randomUUID()}.txt`;
const expected = new TextEncoder().encode("knot-cloud-provider-smoke-test");
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
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
      ContentType: "text/plain",
      IfNoneMatch: "*",
    }),
  );
  uploaded = true;
  const stored = await r2.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const actual = await stored.Body?.transformToByteArray();
  if (
    !actual ||
    Buffer.compare(Buffer.from(actual), Buffer.from(expected)) !== 0
  ) {
    throw new Error("R2 smoke object did not round-trip exactly");
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

console.log("Neon role and R2 object round-trip verified.");
