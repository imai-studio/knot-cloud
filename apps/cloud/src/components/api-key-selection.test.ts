import { describe, expect, it } from "vitest";

import {
  availableScopesForConnectors,
  pruneConnectorSelection,
  pruneScopeSelection,
  type ApiKeyConnectorOption,
} from "./api-key-selection";

const read = "anytype.objects.read" as const;
const write = "anytype.objects.write" as const;

const connectors: ApiKeyConnectorOption[] = [
  {
    id: "reader",
    name: "Reader",
    revokedAt: null,
    scopes: [read],
  },
  {
    id: "writer",
    name: "Writer",
    revokedAt: null,
    scopes: [read, write],
  },
  {
    id: "revoked",
    name: "Revoked",
    revokedAt: "2026-09-02T12:00:00.000Z",
    scopes: [read, write],
  },
];

describe("API key selection", () => {
  it("keeps only active connector selections", () => {
    expect(
      pruneConnectorSelection(connectors, ["writer", "revoked", "missing"]),
    ).toEqual(["writer"]);
  });

  it("offers only the intersection granted by every selected connector", () => {
    expect(
      availableScopesForConnectors(
        connectors,
        ["reader", "writer"],
        [read, write],
      ),
    ).toEqual([read]);
    expect(
      availableScopesForConnectors(connectors, ["revoked"], [read, write]),
    ).toEqual([]);
  });

  it("prunes checked operations when connector availability narrows", () => {
    expect(pruneScopeSelection([read, write], [read])).toEqual([read]);
  });
});
