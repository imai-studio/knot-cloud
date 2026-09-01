"use client";

import type {
  ConsumerApiKeyMetadata,
  ScopeName,
} from "@imai/knot-cloud-contract";
import { Copy, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const commonScopes: ScopeName[] = [
  "anytype.objects.read",
  "anytype.objects.write",
  "anytype.collections.read",
  "anytype.collections.write",
  "anytype.files.read",
  "anytype.files.write",
  "anytype.chats.read",
  "anytype.chats.send",
];

interface ConnectorOption {
  id: string;
  name: string;
  revokedAt: string | null;
  scopes: string[];
}

export function ApiKeyManager({
  connectors,
  initialKeys,
}: {
  connectors: ConnectorOption[];
  initialKeys: ConsumerApiKeyMetadata[];
}) {
  const [keys, setKeys] = useState(initialKeys);
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [selectedConnectorIds, setSelectedConnectorIds] = useState<string[]>(
    [],
  );

  async function refresh() {
    const response = await fetch("/api/v1/session/api-keys", {
      cache: "no-store",
    });
    if (response.ok) setKeys((await response.json()).apiKeys);
  }

  async function create(formData: FormData) {
    setBusy(true);
    setError(undefined);
    setSecret(undefined);
    try {
      const scopes = formData.getAll("scopes");
      const connectorIds = formData.getAll("connectorIds").map(String);
      if (connectorIds.length === 0) {
        throw new Error("Select at least one active connector.");
      }
      if (scopes.length === 0) {
        throw new Error("Select at least one allowed operation.");
      }
      const expiryDays = Number(formData.get("expiryDays"));
      const expiresAt =
        Number.isFinite(expiryDays) && expiryDays > 0
          ? Math.floor(Date.now() / 1_000) + expiryDays * 24 * 60 * 60
          : undefined;
      const response = await fetch("/api/v1/session/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: formData.get("name"),
          connectorIds,
          scopes,
          ...(expiresAt ? { expiresAt } : {}),
          requestsPerMinute: Number(formData.get("requestsPerMinute")),
          requestsPerDay: Number(formData.get("requestsPerDay")),
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.title ?? "Could not create API key");
      setSecret(body.secret);
      await refresh();
    } catch (currentError) {
      setError(
        currentError instanceof Error ? currentError.message : "Request failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function rotate(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/session/api-keys/${id}/rotate`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.title ?? "Could not rotate API key");
      setSecret(body.secret);
      await refresh();
    } catch (currentError) {
      setError(
        currentError instanceof Error ? currentError.message : "Request failed",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/v1/session/api-keys/${id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.title ?? "Could not revoke API key");
      }
      await refresh();
    } catch (currentError) {
      setError(
        currentError instanceof Error ? currentError.message : "Request failed",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-4xl">
      <div className="flex items-start gap-3">
        <KeyRound className="mt-1 size-5 text-primary" />
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
            API keys
          </h1>
          <p className="mt-2 leading-7 text-muted-foreground">
            Each key can submit only the Anytype operations and connectors
            selected here.
          </p>
        </div>
      </div>

      {secret ? (
        <section className="mt-8 border-y bg-accent/45 px-4 py-5">
          <p className="text-sm font-medium">Copy this secret now</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Knot stores only its digest. This value will not be shown again.
          </p>
          <div className="mt-3 flex gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 text-xs">
              {secret}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => navigator.clipboard.writeText(secret)}
              aria-label="Copy API key"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </section>
      ) : null}

      <form action={create} className="mt-8 border-t pt-7">
        <h2 className="font-heading text-xl font-medium">Create a key</h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              name="name"
              placeholder="Reporting integration"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="key-expiry">Expires</Label>
            <select
              id="key-expiry"
              name="expiryDays"
              defaultValue="90"
              className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
              <option value="0">No automatic expiry</option>
            </select>
            <p className="text-xs leading-5 text-muted-foreground">
              Prefer a short expiry. You can rotate or revoke the key sooner.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="per-minute">Requests per minute</Label>
            <Input
              id="per-minute"
              name="requestsPerMinute"
              type="number"
              min="1"
              max="1000"
              defaultValue="60"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="per-day">Requests per day</Label>
            <Input
              id="per-day"
              name="requestsPerDay"
              type="number"
              min="1"
              max="1000000"
              defaultValue="10000"
            />
          </div>
        </div>
        <fieldset className="mt-6">
          <legend className="text-sm font-medium">Allowed connectors</legend>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            The key can submit work only to the connectors selected here. Their
            own scopes and local policy still apply.
          </p>
          {connectors.filter((connector) => !connector.revokedAt).length ===
          0 ? (
            <p className="mt-3 border-y py-4 text-sm text-muted-foreground">
              Pair an active connector before creating an API key.
            </p>
          ) : (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {connectors
                .filter((connector) => !connector.revokedAt)
                .map((connector) => (
                  <label
                    key={connector.id}
                    className="flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
                  >
                    <input
                      className="mt-0.5 size-4"
                      checked={selectedConnectorIds.includes(connector.id)}
                      type="checkbox"
                      name="connectorIds"
                      value={connector.id}
                      onChange={(event) =>
                        setSelectedConnectorIds((current) =>
                          event.target.checked
                            ? [...current, connector.id]
                            : current.filter((id) => id !== connector.id),
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block font-medium">
                        {connector.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {connector.scopes.length} granted scope
                        {connector.scopes.length === 1 ? "" : "s"}
                      </span>
                    </span>
                  </label>
                ))}
            </div>
          )}
        </fieldset>
        <fieldset className="mt-6">
          <legend className="text-sm font-medium">Allowed operations</legend>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {commonScopes.map((scope) => (
              <ScopeChoice
                key={scope}
                scope={scope}
                available={
                  selectedConnectorIds.length > 0 &&
                  selectedConnectorIds.every((connectorId) =>
                    connectors
                      .find((connector) => connector.id === connectorId)
                      ?.scopes.includes(scope),
                  )
                }
              />
            ))}
          </div>
        </fieldset>
        <Button
          className="mt-6"
          type="submit"
          disabled={
            busy ||
            connectors.every((connector) => Boolean(connector.revokedAt))
          }
        >
          <Plus className="size-4" />
          Create API key
        </Button>
      </form>

      {error ? <p className="mt-5 text-sm text-destructive">{error}</p> : null}

      <section className="mt-10 border-t pt-7">
        <h2 className="font-heading text-xl font-medium">Workspace keys</h2>
        {keys.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No API keys have been created.
          </p>
        ) : (
          <div className="mt-4 divide-y border-y">
            {keys.map((key) => (
              <article key={key.id} className="py-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="font-medium">{key.name}</p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground">
                      {key.keyId} · {key.connectorIds.length} connector(s)
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {key.revokedAt
                        ? "Revoked"
                        : `${expiryLabel(key.expiresAt)} · ${key.scopes.join(", ")}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || !isRotatable(key)}
                      onClick={() => rotate(key.id)}
                    >
                      <RefreshCw className="size-4" /> Rotate
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy || Boolean(key.revokedAt)}
                      onClick={() => revoke(key.id)}
                    >
                      <Trash2 className="size-4" /> Revoke
                    </Button>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function expiryLabel(value: number | null) {
  if (value === null) return "No automatic expiry";
  const date = new Date(value * 1_000);
  return date.getTime() <= Date.now()
    ? `Expired ${date.toLocaleDateString()}`
    : `Expires ${date.toLocaleDateString()}`;
}

function isRotatable(key: ConsumerApiKeyMetadata) {
  return (
    key.revokedAt === null &&
    (key.expiresAt === null || key.expiresAt * 1_000 > Date.now())
  );
}

function ScopeChoice({
  available,
  scope,
}: {
  available: boolean;
  scope: ScopeName;
}) {
  return (
    <label
      className={`flex min-h-9 items-center gap-2 text-sm ${
        available ? "" : "text-muted-foreground"
      }`}
    >
      <input
        type="checkbox"
        name="scopes"
        value={scope}
        disabled={!available}
      />
      <span>{scope}</span>
    </label>
  );
}
