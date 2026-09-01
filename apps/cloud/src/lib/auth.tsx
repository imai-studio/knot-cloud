import { createHash } from "node:crypto";

import { APIError, betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { Resend } from "resend";

import { MagicLinkEmail } from "@/lib/auth-email";
import {
  getCloudEnvironment,
  getEmailEnvironment,
  getTrustedAuthOrigins,
  isAllowedEmail,
} from "@/lib/env";

let authInstance: ReturnType<typeof createAuth> | undefined;
let databasePool: Pool | undefined;
let authDatabase: Kysely<Record<string, unknown>> | undefined;

export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}

export async function getAuthorizedSession(requestHeaders: Headers) {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  return session && isAllowedEmail(session.user.email) ? session : null;
}

export function isTrustedHumanMutationOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    return false;
  }
  return getTrustedAuthOrigins().includes(normalizedOrigin);
}

function createAuth() {
  const cloud = getCloudEnvironment();
  const email = getEmailEnvironment();
  const resend = new Resend(email.RESEND_API_KEY);

  databasePool ??= new Pool({
    connectionString: cloud.DATABASE_URL,
    max: 4,
  });
  authDatabase ??= new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: databasePool }),
  }).withSchema("auth");

  return betterAuth({
    appName: "Knot",
    baseURL: cloud.AUTH_BASE_URL,
    database: kyselyAdapter(authDatabase, {
      type: "postgres",
      transaction: true,
    }),
    secret: cloud.AUTH_SECRET,
    trustedOrigins: getTrustedAuthOrigins(),
    session: {
      expiresIn: 60 * 60 * 24,
      updateAge: 60 * 60 * 6,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 20,
      storage: "database",
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for"] },
    },
    plugins: [
      magicLink({
        expiresIn: 60 * 10,
        storeToken: "hashed",
        rateLimit: { window: 60, max: 5 },
        async sendMagicLink({ email: recipient, token, url }) {
          if (!isAllowedEmail(recipient)) {
            return;
          }

          const response = await resend.emails.send(
            {
              from: email.EMAIL_FROM,
              to: recipient,
              subject: "Sign in to Knot",
              react: <MagicLinkEmail url={url} />,
            },
            {
              idempotencyKey: `knot-magic-${createHash("sha256")
                .update(token)
                .digest("hex")
                .slice(0, 40)}`,
            },
          );

          if (response.error) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "The sign-in email could not be sent.",
            });
          }
        },
      }),
    ],
  });
}
