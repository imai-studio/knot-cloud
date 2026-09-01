import { z } from "zod";
import { normalizeAuthority } from "@imai/knot-cloud-contract";

const optionalNonEmptyString = (minimumLength = 1) =>
  z.preprocess(
    (value) =>
      typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(minimumLength).optional(),
  );

const coreEnvironmentSchema = z.object({
  APP_BASE_URL: z.url(),
  AUTH_BASE_URL: z.url(),
  AUTH_TRUSTED_ORIGINS: optionalNonEmptyString(),
  DATABASE_URL: z.string().min(1),
  AUTH_SECRET: z.string().min(32),
  CRON_SECRET: z.string().min(32),
  API_KEY_PEPPER: z.string().min(32),
  API_KEY_PEPPER_VERSION: z.coerce.number().int().positive().default(1),
  API_KEY_PEPPER_PREVIOUS: optionalNonEmptyString(32),
  IDENTITY_DIGEST_PEPPER: z.string().min(32),
  IDENTITY_DIGEST_VERSION: z.coerce.number().int().positive().default(1),
  KNOT_SIGNING_AUTHORITIES: optionalNonEmptyString(),
});

const appBaseUrlSchema = z.url();

const r2EnvironmentSchema = z.object({
  R2_ACCOUNT_ID: z.string().min(1),
  R2_BUCKET_NAME: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/u),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_MAX_OBJECT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(134_217_728)
    .default(33_554_432),
});

const upstashEnvironmentSchema = z.object({
  UPSTASH_REDIS_REST_URL: z.url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
});

const emailAddress = z.email();
const contentEnvironmentSchema = z.object({
  APP_BASE_URL: z.url(),
  CONTENT_BASE_URL: optionalNonEmptyString(),
});
const emailEnvironmentSchema = z.object({
  EMAIL_FROM: z
    .string()
    .min(3)
    .max(320)
    .refine((value) => {
      const bracketed = value.match(/<([^<>]+)>\s*$/u)?.[1];
      return emailAddress.safeParse(bracketed ?? value.trim()).success;
    }, "EMAIL_FROM must contain a valid email address"),
  KNOT_ALLOWED_EMAILS: z
    .string()
    .min(3)
    .refine(
      (value) =>
        value
          .split(",")
          .map((email) => email.trim())
          .filter(Boolean)
          .every((email) => emailAddress.safeParse(email).success),
      "KNOT_ALLOWED_EMAILS must be a comma-separated list of email addresses",
    ),
  RESEND_API_KEY: z.string().min(1),
});

export type CloudEnvironment = z.infer<typeof coreEnvironmentSchema>;

let cachedEnvironment: CloudEnvironment | undefined;

export function getCloudEnvironment(): CloudEnvironment {
  if (process.env.MIGRATION_DATABASE_URL) {
    throw new Error(
      "MIGRATION_DATABASE_URL must not be present in the application runtime",
    );
  }
  cachedEnvironment ??= parseCloudEnvironment(process.env);
  return cachedEnvironment;
}

export function parseCloudEnvironment(
  input: Record<string, string | undefined>,
): CloudEnvironment {
  return coreEnvironmentSchema.parse(input);
}

/**
 * Read the public application origin without requiring unrelated providers.
 * Error responses use this trusted deployment setting instead of the request
 * Host header, which is controlled by the caller at the HTTP boundary.
 */
export function getAppBaseUrl(): string {
  return appBaseUrlSchema.parse(process.env.APP_BASE_URL);
}

export const requiredEnvironmentKeys = [
  "API_KEY_PEPPER",
  "API_KEY_PEPPER_VERSION",
  "APP_BASE_URL",
  "AUTH_BASE_URL",
  "AUTH_SECRET",
  "CRON_SECRET",
  "DATABASE_URL",
  "IDENTITY_DIGEST_PEPPER",
  "IDENTITY_DIGEST_VERSION",
  "EMAIL_FROM",
  "KNOT_ALLOWED_EMAILS",
  "RESEND_API_KEY",
] as const;

export function getSigningAuthorities(): string[] {
  return signingAuthoritiesFromEnvironment(getCloudEnvironment());
}

export function getTrustedAuthOrigins(): string[] {
  return trustedAuthOriginsFromEnvironment(getCloudEnvironment());
}

export function trustedAuthOriginsFromEnvironment(
  environment: CloudEnvironment,
): string[] {
  const configured = environment.AUTH_TRUSTED_ORIGINS?.split(",") ?? [];
  return [environment.AUTH_BASE_URL, environment.APP_BASE_URL, ...configured]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => new URL(value).origin)
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function signingAuthoritiesFromEnvironment(
  environment: CloudEnvironment,
): string[] {
  const configured = environment.KNOT_SIGNING_AUTHORITIES?.split(",") ?? [];
  return [new URL(environment.APP_BASE_URL).host, ...configured]
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeAuthority)
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function getApiKeyPeppers(): Array<{ version: number; value: string }> {
  const environment = getCloudEnvironment();
  const peppers = [
    {
      version: environment.API_KEY_PEPPER_VERSION,
      value: environment.API_KEY_PEPPER,
    },
  ];
  if (environment.API_KEY_PEPPER_PREVIOUS) {
    if (environment.API_KEY_PEPPER_VERSION === 1) {
      throw new Error(
        "API_KEY_PEPPER_PREVIOUS requires API_KEY_PEPPER_VERSION greater than 1",
      );
    }
    peppers.push({
      version: environment.API_KEY_PEPPER_VERSION - 1,
      value: environment.API_KEY_PEPPER_PREVIOUS,
    });
  }
  return peppers;
}

export function getR2Environment() {
  return parseR2Environment(process.env);
}

export function parseR2Environment(input: Record<string, string | undefined>) {
  return r2EnvironmentSchema.parse(input);
}

export function getUpstashEnvironment() {
  return parseUpstashEnvironment(process.env);
}

export function parseUpstashEnvironment(
  input: Record<string, string | undefined>,
) {
  const explicitUrl = nonBlank(input.UPSTASH_REDIS_REST_URL);
  const explicitToken = nonBlank(input.UPSTASH_REDIS_REST_TOKEN);
  const hasExplicitConfiguration =
    explicitUrl !== undefined || explicitToken !== undefined;

  return upstashEnvironmentSchema.parse({
    UPSTASH_REDIS_REST_URL: hasExplicitConfiguration
      ? explicitUrl
      : nonBlank(input.KV_REST_API_URL),
    UPSTASH_REDIS_REST_TOKEN: hasExplicitConfiguration
      ? explicitToken
      : nonBlank(input.KV_REST_API_TOKEN),
  });
}

export function getEmailEnvironment() {
  return parseEmailEnvironment(process.env);
}

export interface ContentEnvironment {
  baseUrl: URL;
}

export function getContentEnvironment(): ContentEnvironment | undefined {
  return parseContentEnvironment(process.env);
}

export function parseContentEnvironment(
  input: Record<string, string | undefined>,
): ContentEnvironment | undefined {
  const parsed = contentEnvironmentSchema.parse(input);
  if (!parsed.CONTENT_BASE_URL) return undefined;
  const application = new URL(parsed.APP_BASE_URL);
  const content = new URL(parsed.CONTENT_BASE_URL);
  if (
    content.username ||
    content.password ||
    content.pathname !== "/" ||
    content.search ||
    content.hash
  ) {
    throw new Error("CONTENT_BASE_URL must be a bare origin");
  }
  if (!isLocalHostname(content.hostname) && content.protocol !== "https:") {
    throw new Error("CONTENT_BASE_URL must use HTTPS");
  }
  if (
    content.origin === application.origin ||
    (!isLocalHostname(content.hostname) &&
      approximateRegistrableDomain(content.hostname) ===
        approximateRegistrableDomain(application.hostname))
  ) {
    throw new Error(
      "CONTENT_BASE_URL must use a separate registrable domain from APP_BASE_URL",
    );
  }
  return { baseUrl: content };
}

export function parseEmailEnvironment(
  input: Record<string, string | undefined>,
) {
  return emailEnvironmentSchema.parse(input);
}

export function getAllowedEmails(): string[] {
  return getEmailEnvironment()
    .KNOT_ALLOWED_EMAILS.split(",")
    .map(normalizeEmail)
    .filter((value, index, all) => value && all.indexOf(value) === index);
}

export function isAllowedEmail(email: string): boolean {
  return getAllowedEmails().includes(normalizeEmail(email));
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function nonBlank(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function approximateRegistrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split(".").filter(Boolean);
  return labels.slice(-2).join(".");
}
