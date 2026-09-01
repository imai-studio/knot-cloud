import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { domainToASCII } from "node:url";

export type ReaderAccess = "public" | "authenticated";
export type CustomDomainStatus = "pending" | "verified" | "failed" | "disabled";

export interface CustomDomainRecord {
  id: string;
  siteId: string;
  hostname: string;
  status: CustomDomainStatus;
  lastErrorCode?: string;
  verifiedAt?: Date;
  lastCheckedAt?: Date;
  challengeExpiresAt: Date;
  createdAt: Date;
}

export interface ReaderGrantRecord {
  id: string;
  siteId: string;
  label: string;
  expiresAt: Date;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt?: Date;
  createdAt: Date;
}

export interface PlatformUsage {
  sites: UsageCounter;
  customDomains: UsageCounter;
  readerGrants: UsageCounter;
  apiKeys: UsageCounter;
  connectors: UsageCounter;
  storageBytes: UsageCounter;
  derivativeJobs: UsageCounter;
}

export interface UsageCounter {
  used: number;
  limit: number;
}

export interface PlatformRepository {
  getSite(input: {
    tenantId: string;
    siteId: string;
  }): Promise<
    { id: string; slug: string; readerAccess: ReaderAccess } | undefined
  >;
  setSiteReaderAccess(input: {
    tenantId: string;
    siteId: string;
    readerAccess: ReaderAccess;
    userId: string;
  }): Promise<boolean>;
  listCustomDomains(input: {
    tenantId: string;
    siteId: string;
  }): Promise<CustomDomainRecord[]>;
  createCustomDomain(input: {
    tenantId: string;
    userId: string;
    siteId: string;
    domainId: string;
    hostname: string;
    challengeDigest: string;
    challengeExpiresAt: Date;
  }): Promise<CustomDomainRecord>;
  recordCustomDomainCheck(input: {
    tenantId: string;
    userId: string;
    domainId: string;
    challengeDigest: string;
    verified: boolean;
    errorCode?: string;
  }): Promise<CustomDomainRecord>;
  disableCustomDomain(input: {
    tenantId: string;
    userId: string;
    domainId: string;
  }): Promise<boolean>;
  listReaderGrants(input: {
    tenantId: string;
    siteId: string;
  }): Promise<ReaderGrantRecord[]>;
  createReaderGrant(input: {
    tenantId: string;
    userId: string;
    siteId: string;
    grantId: string;
    label: string;
    tokenDigest: string;
    expiresAt: Date;
    maxRedemptions: number;
  }): Promise<ReaderGrantRecord>;
  revokeReaderGrant(input: {
    tenantId: string;
    userId: string;
    grantId: string;
  }): Promise<boolean>;
  redeemReaderGrant(input: {
    grantDigest: string;
    expectedSiteSlug: string;
    sessionId: string;
    sessionDigest: string;
    sessionExpiresAt: Date;
  }): Promise<
    | {
        tenantId: string;
        siteId: string;
        siteSlug: string;
        sessionExpiresAt: Date;
      }
    | undefined
  >;
  getUsage(tenantId: string): Promise<PlatformUsage>;
}

export interface DomainTxtVerifier {
  resolve(name: string): Promise<string[][]>;
}

export type ProviderCapability =
  | { available: true }
  | {
      available: false;
      reasonCode:
        "provider-not-configured" | "licensing-required" | "kms-required";
    };

export interface PlatformCapabilities {
  customDomains: { available: boolean; reasonCode?: "provider-not-configured" };
  authenticatedReaders: { available: true };
  mediaDerivatives: ProviderCapability;
  hostedConnectors: ProviderCapability;
  billing: ProviderCapability;
}

export interface BillingProvider {
  readonly capability: ProviderCapability;
}

export interface HostedConnectorProvider {
  readonly capability: ProviderCapability;
}

export interface MediaDerivativeProvider {
  readonly capability: ProviderCapability;
}

export class DisabledBillingProvider implements BillingProvider {
  readonly capability: ProviderCapability = {
    available: false,
    reasonCode: "provider-not-configured",
  };
}

export class DisabledHostedConnectorProvider implements HostedConnectorProvider {
  readonly capability: ProviderCapability = {
    available: false,
    reasonCode: "licensing-required",
  };
}

export class DisabledMediaDerivativeProvider implements MediaDerivativeProvider {
  readonly capability: ProviderCapability = {
    available: false,
    reasonCode: "kms-required",
  };
}

export class PlatformService {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly challengeSecret: string | undefined,
    private readonly txt: DomainTxtVerifier,
    private readonly providers: {
      billing: BillingProvider;
      hostedConnectors: HostedConnectorProvider;
      mediaDerivatives: MediaDerivativeProvider;
    } = {
      billing: new DisabledBillingProvider(),
      hostedConnectors: new DisabledHostedConnectorProvider(),
      mediaDerivatives: new DisabledMediaDerivativeProvider(),
    },
  ) {}

  capabilities(): PlatformCapabilities {
    return {
      customDomains: this.challengeSecret
        ? { available: true }
        : { available: false, reasonCode: "provider-not-configured" },
      authenticatedReaders: { available: true },
      mediaDerivatives: this.providers.mediaDerivatives.capability,
      hostedConnectors: this.providers.hostedConnectors.capability,
      billing: this.providers.billing.capability,
    };
  }

  async createCustomDomain(input: {
    tenantId: string;
    userId: string;
    siteId: string;
    hostname: string;
  }) {
    const hostname = normalizeCustomHostname(input.hostname);
    const domainId = randomUUID();
    const challenge = this.domainChallenge(domainId, hostname);
    const challengeExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000);
    const domain = await this.repository.createCustomDomain({
      ...input,
      domainId,
      hostname,
      challengeDigest: sha256(challenge),
      challengeExpiresAt,
    });
    return {
      ...domain,
      dnsName: `_knot.${hostname}`,
      dnsValue: `knot-domain-verification=${challenge}`,
    };
  }

  listCustomDomains(input: { tenantId: string; siteId: string }) {
    return this.repository.listCustomDomains(input);
  }

  async verificationInstructions(domain: CustomDomainRecord) {
    const challenge = this.domainChallenge(domain.id, domain.hostname);
    return {
      dnsName: `_knot.${domain.hostname}`,
      dnsValue: `knot-domain-verification=${challenge}`,
    };
  }

  async verifyCustomDomain(input: {
    tenantId: string;
    userId: string;
    domain: CustomDomainRecord;
  }) {
    const instructions = await this.verificationInstructions(input.domain);
    let verified = false;
    let errorCode: string | undefined;
    try {
      const records = await this.txt.resolve(instructions.dnsName);
      verified = records.some(
        (segments) => segments.join("") === instructions.dnsValue,
      );
      if (!verified) errorCode = "challenge-not-found";
    } catch {
      errorCode = "dns-lookup-failed";
    }
    return this.repository.recordCustomDomainCheck({
      tenantId: input.tenantId,
      userId: input.userId,
      domainId: input.domain.id,
      challengeDigest: sha256(
        this.domainChallenge(input.domain.id, input.domain.hostname),
      ),
      verified,
      errorCode,
    });
  }

  createReaderGrant(input: {
    tenantId: string;
    userId: string;
    siteId: string;
    label: string;
    expiresAt: Date;
    maxRedemptions: number;
  }) {
    const token = `knot_reader_${randomBytes(32).toString("base64url")}`;
    return this.repository
      .createReaderGrant({
        ...input,
        grantId: randomUUID(),
        tokenDigest: sha256(token),
      })
      .then((grant) => ({ grant, token }));
  }

  async redeemReaderGrant(token: string, expectedSiteSlug: string) {
    if (!/^knot_reader_[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(expectedSiteSlug)) return undefined;
    const sessionToken = `knot_session_${randomBytes(32).toString("base64url")}`;
    const redeemed = await this.repository.redeemReaderGrant({
      grantDigest: sha256(token),
      expectedSiteSlug,
      sessionId: randomUUID(),
      sessionDigest: sha256(sessionToken),
      sessionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
    });
    return redeemed ? { ...redeemed, sessionToken } : undefined;
  }

  private domainChallenge(domainId: string, hostname: string): string {
    if (!this.challengeSecret || this.challengeSecret.length < 32) {
      throw new PlatformUnavailableError(
        "custom-domain-verification-not-configured",
      );
    }
    return createHmac("sha256", this.challengeSecret)
      .update(`${domainId}:${hostname}`, "utf8")
      .digest("base64url");
  }
}

export class PlatformUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function normalizeCustomHostname(input: string): string {
  const value = input.trim().toLowerCase().replace(/\.$/u, "");
  if (value.includes(":") || value.includes("/") || value.includes("@")) {
    throw new TypeError("Custom domain must be a bare hostname");
  }
  const ascii = domainToASCII(value);
  if (
    !ascii ||
    ascii.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/u.test(
      ascii,
    )
  ) {
    throw new TypeError("Custom domain is not valid");
  }
  return ascii;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
