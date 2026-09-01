import { beforeEach, describe, expect, it, vi } from "vitest";

type QueryTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => unknown;
type BuildQueries = (transaction: QueryTag) => unknown[];

const database = vi.hoisted(() => ({
  capturedSql: [] as string[],
  ensureRuntimeDatabaseRole: vi.fn<() => Promise<void>>(),
  pollRows: [] as unknown[],
  query: vi.fn<(text: string, values: unknown[]) => Promise<unknown[]>>(),
  tenantResults: [] as unknown[],
  withTenant:
    vi.fn<
      (tenantId: string, buildQueries: BuildQueries) => Promise<unknown[]>
    >(),
}));

vi.mock("./neon", () => ({
  ensureRuntimeDatabaseRole: database.ensureRuntimeDatabaseRole,
  getSql: () => ({ query: database.query }),
  withTenant: database.withTenant,
}));

import { NeonPairingRepository } from "./neon-pairing";

const tenantId = "10000000-0000-4000-8000-000000000001";
const pairingId = "10000000-0000-4000-8000-000000000002";
const connectorId = "10000000-0000-4000-8000-000000000003";
const siteId = "10000000-0000-4000-8000-000000000004";
const now = new Date("2026-09-02T08:00:00.000Z");
const publicKey = new Uint8Array(32).fill(7);

beforeEach(() => {
  database.capturedSql.length = 0;
  database.pollRows = [];
  database.tenantResults = [];
  database.ensureRuntimeDatabaseRole.mockReset().mockResolvedValue();
  database.query.mockReset().mockImplementation(async (text) => {
    database.capturedSql.push(text);
    return database.pollRows;
  });
  database.withTenant.mockReset().mockImplementation(async (_tenant, build) => {
    const transaction: QueryTag = (strings, ...values) => {
      const text = strings.join("?");
      database.capturedSql.push(text);
      return { text, values };
    };
    build(transaction);
    return database.tenantResults;
  });
});

describe("Neon pairing array decoding", () => {
  it("casts and maps pairing review arrays", async () => {
    database.tenantResults = [
      [],
      [
        reviewRow({
          requested_scopes: ["anytype.objects.read"],
          requested_site_ids: [siteId],
          requested_slug_grants: ["notes/*"],
          granted_scopes: ["anytype.objects.read"],
          granted_site_ids: [siteId],
          granted_slug_grants: ["notes/*"],
        }),
      ],
    ];

    const [review] = await new NeonPairingRepository().listReviews(tenantId);

    expect(review).toMatchObject({
      requestedScopes: ["anytype.objects.read"],
      requestedSiteIds: [siteId],
      requestedSlugGrants: ["notes/*"],
      grantedScopes: ["anytype.objects.read"],
      grantedSiteIds: [siteId],
      grantedSlugGrants: ["notes/*"],
    });
    expect(capturedSql()).toContain(
      "requested_scopes::text[] AS requested_scopes",
    );
    expect(capturedSql()).toContain(
      "requested_site_ids::text[] AS requested_site_ids",
    );
    expect(capturedSql()).toContain(
      "requested_slug_grants::text[] AS requested_slug_grants",
    );
    expect(capturedSql()).toContain("granted_scopes::text[] AS granted_scopes");
    expect(capturedSql()).toContain(
      "granted_site_ids::text[] AS granted_site_ids",
    );
    expect(capturedSql()).toContain(
      "granted_slug_grants::text[] AS granted_slug_grants",
    );
  });

  it("rejects a pairing review custom-enum array returned as a string", async () => {
    database.tenantResults = [
      [],
      [reviewRow({ requested_scopes: "{anytype.objects.read}" })],
    ];

    await expect(
      new NeonPairingRepository().listReviews(tenantId),
    ).rejects.toThrow(
      "pairing requested scopes must be returned as a text array",
    );
  });

  it("casts and maps connector scope arrays", async () => {
    database.tenantResults = [
      [
        connectorRow({
          scopes: ["anytype.chats.read", "anytype.chats.send"],
          site_ids: [siteId],
          slug_grants: ["chat/*"],
        }),
      ],
    ];

    const [connector] = await new NeonPairingRepository().listConnectors(
      tenantId,
    );

    expect(connector).toMatchObject({
      scopes: ["anytype.chats.read", "anytype.chats.send"],
      siteIds: [siteId],
      slugGrants: ["chat/*"],
    });
    expect(capturedSql()).toContain("connector.scopes::text[] AS scopes");
  });

  it("rejects a connector custom-enum array returned as a string", async () => {
    database.tenantResults = [
      [connectorRow({ scopes: "{anytype.objects.read}" })],
    ];

    await expect(
      new NeonPairingRepository().listConnectors(tenantId),
    ).rejects.toThrow("connector scopes must be returned as a text array");
  });

  it("casts and maps approved pairing poll grant arrays", async () => {
    database.pollRows = [
      pollRow({
        granted_scopes: ["publications.write"],
        granted_site_ids: [siteId],
        granted_slug_grants: ["published/*"],
      }),
    ];

    const result = await new NeonPairingRepository().poll({
      pairingId,
      pollTokenDigest: "a".repeat(64),
      now,
    });

    expect(result).toMatchObject({
      status: "approved",
      grant: {
        scopes: ["publications.write"],
        siteIds: [siteId],
        slugGrants: ["published/*"],
      },
    });
    expect(capturedSql()).toContain("granted_scopes::text[] AS granted_scopes");
    expect(capturedSql()).toContain(
      "granted_site_ids::text[] AS granted_site_ids",
    );
    expect(capturedSql()).toContain(
      "granted_slug_grants::text[] AS granted_slug_grants",
    );
  });

  it("rejects an approved poll custom-enum array returned as a string", async () => {
    database.pollRows = [pollRow({ granted_scopes: "{publications.write}" })];

    await expect(
      new NeonPairingRepository().poll({
        pairingId,
        pollTokenDigest: "a".repeat(64),
        now,
      }),
    ).rejects.toThrow(
      "pairing granted scopes must be returned as a text array",
    );
  });
});

function capturedSql(): string {
  return database.capturedSql.join("\n");
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: pairingId,
    connector_name: "Local agent",
    public_key: publicKey,
    protocol_version: "1.0",
    requested_scopes: ["anytype.objects.read"],
    requested_site_ids: [],
    requested_slug_grants: [],
    status: "approved",
    expires_at: new Date("2026-09-02T08:10:00.000Z"),
    created_at: new Date("2026-09-02T07:50:00.000Z"),
    approved_at: now,
    denied_at: null,
    poll_consumed_at: null,
    granted_scopes: null,
    granted_site_ids: null,
    granted_slug_grants: null,
    ...overrides,
  };
}

function connectorRow(overrides: Record<string, unknown> = {}) {
  return {
    id: connectorId,
    name: "Local agent",
    public_key: publicKey,
    protocol_version: "1.0",
    scopes: ["anytype.objects.read"],
    site_ids: [],
    slug_grants: [],
    revoked_at: null,
    last_seen_at: null,
    created_at: now,
    ...overrides,
  };
}

function pollRow(overrides: Record<string, unknown> = {}) {
  return {
    pairing_id: pairingId,
    status: "approved",
    expires_at: new Date("2026-09-02T08:10:00.000Z"),
    connector_id: connectorId,
    tenant_id: tenantId,
    granted_scopes: ["publications.write"],
    granted_site_ids: [],
    granted_slug_grants: [],
    approved_at: now,
    ...overrides,
  };
}
