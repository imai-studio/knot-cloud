import { randomBytes, randomUUID } from "node:crypto";

import {
  canonicalJson,
  type PublicationControlResult,
  type PublicationMutation,
  sha256Hex,
} from "@imai/knot-cloud-contract";

import { publicationBundleKeyFor } from "@/lib/adapters/r2";
import type { ObjectStore } from "@/lib/ports";

const bundleContentType = "application/vnd.imai.knot.publication+json" as const;

export interface SiteRecord {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
}

export interface PublicationRecord {
  id: string;
  siteId: string;
  slug: string;
  currentVersionId?: string;
  disabledAt?: Date;
  unpublishedAt?: Date;
  updatedAt: Date;
}

export interface PublicationVersionRecord {
  id: string;
  state: "draft" | "ready" | "disabled" | "unpublished" | "abandoned";
  schemaVersion: string;
  contentSha256: string;
  connectorId: string;
  createdAt: Date;
  committedAt?: Date;
}

export interface ConnectorPublicationStatus {
  publicationId: string;
  siteId: string;
  slug: string;
  state: "draft" | "ready" | "disabled" | "unpublished";
  currentVersionId?: string;
  updatedAt: Date;
}

export interface PreparedAssetUpload {
  uploadId: string;
  assetId: string;
  expiresAt: Date;
  duplicate: boolean;
}

export interface PreparedPublicationVersion {
  publicationId: string;
  versionId: string;
  bundlePath: string;
  state: "draft" | "ready" | "disabled" | "unpublished" | "abandoned";
  duplicate: boolean;
}

export interface PublicationRepository {
  listSites(tenantId: string): Promise<SiteRecord[]>;
  createSite(input: {
    tenantId: string;
    name: string;
    slug: string;
  }): Promise<SiteRecord>;
  listPublications(input: {
    tenantId: string;
    siteId: string;
  }): Promise<PublicationRecord[]>;
  listPublicationVersions(input: {
    tenantId: string;
    publicationId: string;
  }): Promise<PublicationVersionRecord[]>;
  prepareAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    siteId: string;
    uploadId: string;
    assetId: string;
    sha256: string;
    pathname: string;
    contentType: string;
    byteSize: number;
    fileName: string;
    idempotencyKey: string;
    expiresAt: Date;
  }): Promise<PreparedAssetUpload>;
  commitAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    uploadId: string;
    assetId: string;
    observedSha256: string;
    observedByteSize: number;
    observedContentType: string;
  }): Promise<{
    assetId: string;
    sha256: string;
    byteSize: number;
    verifiedAt: Date;
  }>;
  preparePublicationVersion(input: {
    tenantId: string;
    connectorId: string;
    siteId: string;
    publicationId: string;
    versionId: string;
    slug: string;
    operation: "create" | "update";
    schemaVersion: "1.0";
    contentSha256: string;
    bundlePath: string;
    document: PublicationMutation["document"];
    sourceProvenance: PublicationMutation["sourceProvenance"];
    idempotencyKey: string;
  }): Promise<PreparedPublicationVersion>;
  commitPublicationVersion(input: {
    tenantId: string;
    connectorId: string;
    publicationId: string;
    versionId: string;
    assetDigests: string[];
  }): Promise<"ready">;
  disable(input: { tenantId: string; publicationId: string }): Promise<Date>;
  rollback(input: {
    tenantId: string;
    publicationId: string;
    versionId: string;
  }): Promise<string>;
  unpublish(input: { tenantId: string; publicationId: string }): Promise<Date>;
  getConnectorStatus(input: {
    tenantId: string;
    connectorId: string;
    publicationId: string;
  }): Promise<ConnectorPublicationStatus>;
  controlAsConnector(input: {
    tenantId: string;
    connectorId: string;
    operation:
      | { type: "publication.disable"; publicationId: string }
      | {
          type: "publication.rollback";
          publicationId: string;
          versionId: string;
        }
      | { type: "publication.unpublish"; publicationId: string };
    idempotencyKey: string;
    requestSha256: string;
  }): Promise<PublicationControlResult>;
}

export class PublicationService {
  constructor(
    private readonly repository: PublicationRepository,
    private readonly objects: ObjectStore,
  ) {}

  async requestAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    siteId: string;
    sha256: string;
    byteSize: number;
    contentType: string;
    fileName: string;
    idempotencyKey: string;
  }) {
    const locator = { tenantId: input.tenantId, sha256: input.sha256 };
    const requestedExpiresAt = new Date(Date.now() + 600_000);
    const prepared = await this.repository.prepareAssetUpload({
      ...input,
      assetId: randomUUID(),
      uploadId: randomUUID(),
      pathname: assetPath(locator),
      expiresAt: requestedExpiresAt,
    });
    const signed = await this.objects.createPresignedAssetUpload({
      locator,
      contentLength: input.byteSize,
      contentType: input.contentType,
      expiresInSeconds: Math.max(
        30,
        Math.min(
          600,
          Math.floor((prepared.expiresAt.getTime() - Date.now()) / 1_000),
        ),
      ),
    });
    return {
      ...prepared,
      uploadUrl: signed.uploadUrl,
      requiredHeaders: signed.requiredHeaders,
      expiresAt:
        prepared.expiresAt < signed.expiresAt
          ? prepared.expiresAt
          : signed.expiresAt,
    };
  }

  async commitAssetUpload(input: {
    tenantId: string;
    connectorId: string;
    uploadId: string;
    assetId: string;
    expectedSha256: string;
    expectedByteSize: number;
  }) {
    const object = await this.objects.verify({
      tenantId: input.tenantId,
      sha256: input.expectedSha256,
    });
    if (!object) throw new Error("asset-upload-missing");
    if (object.size !== input.expectedByteSize) {
      throw new Error("asset-size-mismatch");
    }
    return this.repository.commitAssetUpload({
      ...input,
      observedSha256: object.sha256,
      observedByteSize: object.size,
      observedContentType: object.contentType,
    });
  }

  async publish(input: {
    tenantId: string;
    connectorId: string;
    mutation: PublicationMutation;
  }): Promise<{
    publicationId: string;
    versionId: string;
    state: "ready";
  }> {
    if (input.mutation.connectorId !== input.connectorId) {
      throw new Error("connector-mismatch");
    }
    const bundle = new TextEncoder().encode(
      canonicalJson(input.mutation.document),
    );
    const digest = await sha256Hex(bundle);
    if (digest !== input.mutation.contentSha256) {
      throw new Error("publication-digest-mismatch");
    }
    const requestedVersionId = randomUUID();
    const requestedPath = publicationBundleKeyFor({
      tenantId: input.tenantId,
      publicationId: input.mutation.publicationId,
      versionId: requestedVersionId,
      sha256: digest,
    });
    const prepared = await this.repository.preparePublicationVersion({
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      siteId: input.mutation.siteId,
      publicationId: input.mutation.publicationId,
      versionId: requestedVersionId,
      slug: input.mutation.slug,
      operation: input.mutation.operation,
      schemaVersion: input.mutation.document.schemaVersion,
      contentSha256: digest,
      bundlePath: requestedPath,
      document: input.mutation.document,
      sourceProvenance: input.mutation.sourceProvenance,
      idempotencyKey: input.mutation.idempotencyKey,
    });
    const stored = await this.objects.putPublicationBundleImmutable({
      locator: {
        tenantId: input.tenantId,
        publicationId: prepared.publicationId,
        versionId: prepared.versionId,
        sha256: digest,
      },
      body: bundle,
      contentLength: bundle.byteLength,
      contentType: bundleContentType,
    });
    if (stored.key !== prepared.bundlePath) {
      throw new Error("publication-bundle-path-mismatch");
    }
    const state = await this.repository.commitPublicationVersion({
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      publicationId: prepared.publicationId,
      versionId: prepared.versionId,
      assetDigests: [...new Set(input.mutation.assetDigests)],
    });
    return {
      publicationId: prepared.publicationId,
      versionId: prepared.versionId,
      state,
    };
  }

  async control(input: {
    tenantId: string;
    operation:
      | { type: "publication.disable"; publicationId: string }
      | {
          type: "publication.rollback";
          publicationId: string;
          versionId: string;
        }
      | { type: "publication.unpublish"; publicationId: string };
  }): Promise<PublicationControlResult> {
    switch (input.operation.type) {
      case "publication.disable": {
        const at = await this.repository.disable({
          tenantId: input.tenantId,
          publicationId: input.operation.publicationId,
        });
        return {
          ...input.operation,
          disabledAt: Math.floor(at.getTime() / 1_000),
        };
      }
      case "publication.rollback": {
        const currentVersionId = await this.repository.rollback({
          tenantId: input.tenantId,
          publicationId: input.operation.publicationId,
          versionId: input.operation.versionId,
        });
        return {
          type: input.operation.type,
          publicationId: input.operation.publicationId,
          currentVersionId,
        };
      }
      case "publication.unpublish": {
        const at = await this.repository.unpublish({
          tenantId: input.tenantId,
          publicationId: input.operation.publicationId,
        });
        return {
          ...input.operation,
          unpublishedAt: Math.floor(at.getTime() / 1_000),
        };
      }
    }
  }

  statusForConnector(input: {
    tenantId: string;
    connectorId: string;
    publicationId: string;
  }): Promise<ConnectorPublicationStatus> {
    return this.repository.getConnectorStatus(input);
  }

  controlAsConnector(input: {
    tenantId: string;
    connectorId: string;
    operation:
      | { type: "publication.disable"; publicationId: string }
      | {
          type: "publication.rollback";
          publicationId: string;
          versionId: string;
        }
      | { type: "publication.unpublish"; publicationId: string };
    idempotencyKey: string;
    requestSha256: string;
  }): Promise<PublicationControlResult> {
    return this.repository.controlAsConnector(input);
  }
}

export interface DeletionOutboxItem {
  id: string;
  publicationId?: string;
  assetId?: string;
  pathname: string;
  tombstonedAt: Date;
  attempt: number;
}

export interface DeletionOutboxRepository {
  listMaintenanceTenants(input: {
    now: Date;
    graceSeconds: number;
    limit: number;
  }): Promise<string[]>;
  sweepOrphans(input: {
    tenantId: string;
    now: Date;
    graceSeconds: number;
    limit: number;
  }): Promise<number>;
  countDeadLetters(input: { tenantId: string }): Promise<number>;
  claim(input: {
    tenantId: string;
    now: Date;
    leaseTokenDigest: string;
    leaseSeconds: number;
    limit: number;
  }): Promise<DeletionOutboxItem[]>;
  complete(input: {
    tenantId: string;
    itemId: string;
    leaseTokenDigest: string;
    now: Date;
  }): Promise<boolean>;
  retry(input: {
    tenantId: string;
    itemId: string;
    leaseTokenDigest: string;
    now: Date;
    delaySeconds: number;
    errorCode: string;
  }): Promise<boolean>;
  finalize(input: {
    tenantId: string;
    publicationId: string;
  }): Promise<boolean>;
}

export class PublicationDeletionWorker {
  constructor(
    private readonly repository: DeletionOutboxRepository,
    private readonly objects: ObjectStore,
  ) {}

  async drainTenant(input: { tenantId: string; limit?: number }): Promise<{
    claimed: number;
    deleted: number;
    retried: number;
    finalized: number;
    deadLettered: number;
  }> {
    const now = new Date();
    const leaseToken = randomBytes(32).toString("base64url");
    const leaseTokenDigest = await sha256Hex(leaseToken);
    const items = await this.repository.claim({
      tenantId: input.tenantId,
      now,
      leaseTokenDigest,
      leaseSeconds: 60,
      limit: input.limit ?? 25,
    });
    let deleted = 0;
    let retried = 0;
    const publications = new Set<string>();
    for (const item of items) {
      if (item.publicationId) publications.add(item.publicationId);
    }
    try {
      await this.objects.deleteTombstoned(
        items.map((item) => ({
          tenantId: input.tenantId,
          key: item.pathname,
          tombstonedAt: item.tombstonedAt,
        })),
      );
      for (const item of items) {
        if (
          await this.repository.complete({
            tenantId: input.tenantId,
            itemId: item.id,
            leaseTokenDigest,
            now: new Date(),
          })
        ) {
          deleted += 1;
        }
      }
    } catch {
      for (const item of items) {
        const delaySeconds = Math.min(86_400, 2 ** Math.min(item.attempt, 16));
        if (
          await this.repository.retry({
            tenantId: input.tenantId,
            itemId: item.id,
            leaseTokenDigest,
            now: new Date(),
            delaySeconds,
            errorCode: "object-delete-failed",
          })
        ) {
          retried += 1;
        }
      }
    }
    let finalized = 0;
    for (const publicationId of publications) {
      if (
        await this.repository.finalize({
          tenantId: input.tenantId,
          publicationId,
        })
      ) {
        finalized += 1;
      }
    }
    const deadLettered = await this.repository.countDeadLetters({
      tenantId: input.tenantId,
    });
    return {
      claimed: items.length,
      deleted,
      retried,
      finalized,
      deadLettered,
    };
  }
}

function assetPath(locator: { tenantId: string; sha256: string }): string {
  return `tenants/${locator.tenantId}/assets/${locator.sha256.slice(0, 2)}/${locator.sha256}`;
}
