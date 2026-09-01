import { problemDetailsSchema } from "@imai/knot-cloud-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTrustedHumanMutationOrigin } from "@/lib/auth";
import type { PublicationRepository } from "@/lib/publications";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

import { createHumanPublicationHandlers } from "./human-publications";

vi.mock("@/lib/auth", () => ({
  isTrustedHumanMutationOrigin: vi.fn(),
}));
vi.mock("@/lib/workspace-auth", () => ({
  getAuthorizedWorkspace: vi.fn(),
}));

const tenantId = "00000000-0000-4000-8000-000000000001";
const siteId = "00000000-0000-4000-8000-000000000021";
const publicationId = "00000000-0000-4000-8000-000000000031";

const authorized = {
  identity: {
    session: { id: "session-1" },
    user: { email: "raj@example.test", id: "user-1", name: "Raj" },
  },
  workspace: {
    name: "Personal workspace",
    role: "owner" as const,
    suspended: false,
    tenantId,
    userId: "00000000-0000-4000-8000-000000000002",
  },
};

describe("human publication HTTP service", () => {
  beforeEach(() => {
    vi.mocked(getAuthorizedWorkspace).mockReset();
    vi.mocked(getAuthorizedWorkspace).mockResolvedValue(authorized);
    vi.mocked(isTrustedHumanMutationOrigin).mockReset();
    vi.mocked(isTrustedHumanMutationOrigin).mockReturnValue(true);
  });

  it("rejects oversized and malformed site bodies before mutation", async () => {
    const repository = publicationRepository();
    const handlers = createHumanPublicationHandlers({
      repository,
      service: { control: vi.fn() },
    });
    const oversized = await handlers.createSite(
      new Request("https://knot.test/api/v1/session/sites", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(64 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(oversized.status).toBe(413);

    const malformed = await handlers.createSite(
      jsonRequest("/api/v1/session/sites", "{"),
    );
    const malformedBody = problemDetailsSchema.parse(await malformed.json());
    expect(malformed.status).toBe(400);
    expect(malformedBody.code).toBe("invalid-request");
    expect(repository.createSite).not.toHaveBeenCalled();
  });

  it.each(["member", "billing-admin"])(
    "denies %s site and publication mutations",
    async (role) => {
      vi.mocked(getAuthorizedWorkspace).mockResolvedValue({
        ...authorized,
        workspace: { ...authorized.workspace, role },
      } as Awaited<ReturnType<typeof getAuthorizedWorkspace>>);
      const repository = publicationRepository();
      const control = vi.fn();
      const handlers = createHumanPublicationHandlers({
        repository,
        service: { control },
      });

      const create = await handlers.createSite(
        jsonRequest("/api/v1/session/sites", {
          name: "Notes",
          slug: "notes",
        }),
      );
      const mutate = await handlers.control(
        jsonRequest(`/api/v1/session/publications/${publicationId}/control`, {
          type: "publication.disable",
        }),
        publicationId,
      );

      expect(create.status).toBe(403);
      expect(mutate.status).toBe(403);
      expect(repository.createSite).not.toHaveBeenCalled();
      expect(control).not.toHaveBeenCalled();
    },
  );

  it("returns conflict only for a known site uniqueness violation", async () => {
    const repository = publicationRepository({
      createSite: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error("duplicate"), { code: "23505" }),
        ),
    });
    const handlers = createHumanPublicationHandlers({
      repository,
      service: { control: vi.fn() },
    });
    const response = await handlers.createSite(
      jsonRequest("/api/v1/session/sites", {
        name: "Notes",
        slug: "notes",
      }),
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(409);
    expect(body.code).toBe("conflict");
    expect(body.retryable).toBe(false);
  });

  it("returns not-found when publication control targets missing state", async () => {
    const control = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("missing"), { code: "P0002" }),
      );
    const handlers = createHumanPublicationHandlers({
      repository: publicationRepository(),
      service: { control },
    });
    const response = await handlers.control(
      jsonRequest(`/api/v1/session/publications/${publicationId}/control`, {
        type: "publication.disable",
      }),
      publicationId,
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(404);
    expect(body.code).toBe("not-found");
    expect(control).toHaveBeenCalledWith({
      tenantId,
      operation: { type: "publication.disable", publicationId },
    });
  });

  it("does not disguise unexpected dependency failures as conflicts", async () => {
    const repository = publicationRepository({
      listPublications: vi
        .fn()
        .mockRejectedValue(new Error("database offline")),
    });
    const handlers = createHumanPublicationHandlers({
      repository,
      service: { control: vi.fn() },
    });
    const response = await handlers.listPublications(
      new Request(
        `https://knot.test/api/v1/session/sites/${siteId}/publications`,
      ),
      siteId,
    );
    const body = problemDetailsSchema.parse(await response.json());

    expect(response.status).toBe(500);
    expect(body.code).toBe("internal-error");
    expect(body.retryable).toBe(true);
  });

  it("lists bounded publication version metadata for the active tenant", async () => {
    const listPublicationVersions = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000041",
        state: "ready",
        schemaVersion: "1.0",
        contentSha256: "a".repeat(64),
        connectorId: "00000000-0000-4000-8000-000000000051",
        createdAt: new Date("2026-09-02T12:00:00.000Z"),
        committedAt: new Date("2026-09-02T12:01:00.000Z"),
      },
    ]);
    const handlers = createHumanPublicationHandlers({
      repository: publicationRepository({ listPublicationVersions }),
      service: { control: vi.fn() },
    });
    const response = await handlers.listPublicationVersions(
      new Request(
        `https://knot.test/api/v1/session/publications/${publicationId}/versions`,
      ),
      publicationId,
    );
    expect(response.status).toBe(200);
    expect(listPublicationVersions).toHaveBeenCalledWith({
      tenantId,
      publicationId,
    });
    await expect(response.json()).resolves.toMatchObject([
      { state: "ready", createdAt: "2026-09-02T12:00:00.000Z" },
    ]);
  });
});

function publicationRepository(
  overrides: Partial<PublicationRepository> = {},
): PublicationRepository {
  return {
    listSites: vi.fn().mockResolvedValue([]),
    createSite: vi.fn(),
    listPublications: vi.fn().mockResolvedValue([]),
    listPublicationVersions: vi.fn().mockResolvedValue([]),
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

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`https://knot.test${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://knot.test",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
