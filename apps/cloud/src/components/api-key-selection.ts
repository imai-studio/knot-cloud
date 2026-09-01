import type { ScopeName } from "@imai/knot-cloud-contract";

export interface ApiKeyConnectorOption {
  id: string;
  name: string;
  revokedAt: string | null;
  scopes: string[];
}

export function activeConnectorIds(connectors: ApiKeyConnectorOption[]) {
  return new Set(
    connectors
      .filter((connector) => connector.revokedAt === null)
      .map((connector) => connector.id),
  );
}

export function pruneConnectorSelection(
  connectors: ApiKeyConnectorOption[],
  selectedConnectorIds: string[],
) {
  const active = activeConnectorIds(connectors);
  return selectedConnectorIds.filter((connectorId) => active.has(connectorId));
}

export function availableScopesForConnectors(
  connectors: ApiKeyConnectorOption[],
  selectedConnectorIds: string[],
  candidateScopes: ScopeName[],
) {
  if (selectedConnectorIds.length === 0) return [];
  const selected = selectedConnectorIds.map((connectorId) =>
    connectors.find(
      (connector) =>
        connector.id === connectorId && connector.revokedAt === null,
    ),
  );
  if (selected.some((connector) => connector === undefined)) return [];
  return candidateScopes.filter((scope) =>
    selected.every((connector) => connector?.scopes.includes(scope)),
  );
}

export function pruneScopeSelection(
  selectedScopes: ScopeName[],
  availableScopes: ScopeName[],
) {
  const available = new Set(availableScopes);
  return selectedScopes.filter((scope) => available.has(scope));
}
