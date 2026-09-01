import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { ObjectStore } from "./ports";
import {
  PublicationDeletionWorker,
  PublicationService,
  type DeletionOutboxRepository,
  type PublicationRepository,
} from "./publications";

const tenantId = "00000000-0000-4000-8000-000000000001";
const connectorId = "00000000-0000-4000-8000-000000000011";
const siteId = "00000000-0000-4000-8000-000000000021";
const publicationId = "00000000-0000-4000-8000-000000000031";
const versionId = "00000000-0000-4000-8000-000000000041";

describe("PublicationService", () => {
  it("stores the canonical bundle before activating its version", async () => {
    const document = {
      schemaVersion: "1.0" as const,
      title: "Page",
      blocks: [],
    };
    const canonical = '{"blocks":[],"schemaVersion":"1.0","title":"Page"}';
    const digest = createHash("sha256").update(canonical).digest("hex");
    const calls: string[] = [];
    const repository = publicationRepository({
      preparePublicationVersion: vi.fn<
        PublicationRepository["preparePublicationVersion"]
      >(async () => {
        calls.push("prepare");
        return {
          publicationId,
          versionId,
          bundlePath: `tenants/${tenantId}/publications/${publicationId}/versions/${versionId}/${digest}.json`,
          state: "draft" as const,
          duplicate: false,
        };
      }),
      commitPublicationVersion: vi.fn<
        PublicationRepository["commitPublicationVersion"]
      >(async () => {
        calls.push("commit");
        return "ready" as const;
      }),
    });
    const objects = objectStore({
      putPublicationBundleImmutable: vi.fn(async (input) => {
        calls.push("store");
        expect(new TextDecoder().decode(input.body as Uint8Array)).toBe(
          canonical,
        );
        return {
          ...input.locator,
          key: `tenants/${tenantId}/publications/${publicationId}/versions/${versionId}/${digest}.json`,
          contentType: input.contentType,
          size: canonical.length,
        };
      }),
    });
    const service = new PublicationService(repository, objects);

    await expect(
      service.publish({
        tenantId,
        connectorId,
        mutation: {
          connectorId,
          siteId,
          publicationId,
          slug: "page",
          operation: "create",
          document,
          contentSha256: digest,
          assetDigests: [],
          idempotencyKey: "publication-key-0001",
        },
      }),
    ).resolves.toEqual({ publicationId, versionId, state: "ready" });
    expect(calls).toEqual(["prepare", "store", "commit"]);
  });

  it("does not prepare a version when the claimed digest is wrong", async () => {
    const repository = publicationRepository();
    const service = new PublicationService(repository, objectStore());
    await expect(
      service.publish({
        tenantId,
        connectorId,
        mutation: {
          connectorId,
          siteId,
          publicationId,
          slug: "page",
          operation: "create",
          document: { schemaVersion: "1.0", title: "Page", blocks: [] },
          contentSha256: "f".repeat(64),
          assetDigests: [],
          idempotencyKey: "publication-key-0001",
        },
      }),
    ).rejects.toThrow("publication-digest-mismatch");
    expect(repository.preparePublicationVersion).not.toHaveBeenCalled();
  });
});

describe("PublicationDeletionWorker", () => {
  it("batch deletes tombstoned objects before completing their fenced rows", async () => {
    const complete = vi.fn().mockResolvedValue(true);
    const retry = vi.fn().mockResolvedValue(true);
    const finalize = vi.fn().mockResolvedValue(false);
    const repository: DeletionOutboxRepository = {
      listMaintenanceTenants: vi.fn(),
      sweepOrphans: vi.fn(),
      countDeadLetters: vi.fn().mockResolvedValue(0),
      claim: vi.fn().mockResolvedValue([
        {
          id: "00000000-0000-4000-8000-000000000051",
          publicationId,
          pathname: `tenants/${tenantId}/assets/aa/${"a".repeat(64)}`,
          tombstonedAt: new Date(),
          attempt: 1,
        },
        {
          id: "00000000-0000-4000-8000-000000000052",
          publicationId,
          pathname: `tenants/${tenantId}/assets/bb/${"b".repeat(64)}`,
          tombstonedAt: new Date(),
          attempt: 2,
        },
      ]),
      complete,
      retry,
      finalize,
    };
    const deleteTombstoned = vi.fn().mockResolvedValue(undefined);
    const worker = new PublicationDeletionWorker(
      repository,
      objectStore({ deleteTombstoned }),
    );

    await expect(worker.drainTenant({ tenantId })).resolves.toEqual({
      claimed: 2,
      deleted: 2,
      retried: 0,
      finalized: 0,
      deadLettered: 0,
    });
    expect(deleteTombstoned).toHaveBeenCalledOnce();
    expect(deleteTombstoned.mock.calls[0]?.[0]).toHaveLength(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(retry).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("retries every fenced row when a batch delete is not fully successful", async () => {
    const retry = vi.fn().mockResolvedValue(true);
    const repository: DeletionOutboxRepository = {
      listMaintenanceTenants: vi.fn(),
      sweepOrphans: vi.fn(),
      countDeadLetters: vi.fn().mockResolvedValue(1),
      claim: vi.fn().mockResolvedValue([
        {
          id: "00000000-0000-4000-8000-000000000051",
          publicationId,
          pathname: `tenants/${tenantId}/assets/aa/${"a".repeat(64)}`,
          tombstonedAt: new Date(),
          attempt: 12,
        },
      ]),
      complete: vi.fn(),
      retry,
      finalize: vi.fn().mockResolvedValue(false),
    };
    const worker = new PublicationDeletionWorker(
      repository,
      objectStore({
        deleteTombstoned: vi
          .fn()
          .mockRejectedValue(new Error("R2 unavailable")),
      }),
    );

    await expect(worker.drainTenant({ tenantId })).resolves.toMatchObject({
      claimed: 1,
      deleted: 0,
      retried: 1,
      deadLettered: 1,
    });
    expect(retry).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        errorCode: "object-delete-failed",
        delaySeconds: 4096,
      }),
    );
  });
});

function publicationRepository(
  overrides: Partial<PublicationRepository> = {},
): PublicationRepository {
  return {
    listSites: vi.fn(),
    createSite: vi.fn(),
    listPublications: vi.fn(),
    listPublicationVersions: vi.fn(),
    prepareAssetUpload: vi.fn(),
    commitAssetUpload: vi.fn(),
    preparePublicationVersion: vi.fn(),
    commitPublicationVersion: vi.fn(),
    disable: vi.fn(),
    rollback: vi.fn(),
    unpublish: vi.fn(),
    getConnectorStatus: vi.fn(),
    controlAsConnector: vi.fn(),
    ...overrides,
  };
}

function objectStore(overrides: Partial<ObjectStore> = {}): ObjectStore {
  return {
    maxObjectBytes: 1024,
    createPresignedAssetUpload: vi.fn(),
    putImmutable: vi.fn(),
    putPublicationBundleImmutable: vi.fn(),
    verify: vi.fn(),
    get: vi.fn(),
    deleteTombstoned: vi.fn(),
    ...overrides,
  };
}
