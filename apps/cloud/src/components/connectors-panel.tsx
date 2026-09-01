"use client";

import { useState } from "react";
import { scopeNameSchema, type PairingScope } from "@imai/knot-cloud-contract";
import { Check, Copy, KeyRound, RefreshCw, ShieldX } from "lucide-react";
import { useRouter } from "next/navigation";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { ManagedConnector, PairingReview } from "@/lib/pairing";

interface SerializedPairingReview extends Omit<
  PairingReview,
  "createdAt" | "expiresAt"
> {
  createdAt: string;
  expiresAt: string;
}

interface SerializedConnector extends Omit<
  ManagedConnector,
  "createdAt" | "lastSeenAt" | "revokedAt"
> {
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

interface PairingSecret {
  authorizationUrl: string;
  expiresAt: number;
  pairingId: string;
  pollToken: string;
}

export function ConnectorsPanel({
  canManage,
  connectors,
  pairings,
}: {
  canManage: boolean;
  connectors: SerializedConnector[];
  pairings: SerializedPairingReview[];
}) {
  const router = useRouter();
  const [connectorName, setConnectorName] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [slugGrants, setSlugGrants] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<PairingScope[]>([
    "anytype.objects.read",
  ]);
  const [pairingSecret, setPairingSecret] = useState<PairingSecret | null>(
    null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createPairing(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const response = await fetch("/api/v1/pairing/sessions", {
        body: JSON.stringify({
          connectorName,
          protocolVersion: "1.0",
          publicKey,
          requestedScopes: selectedScopes,
          requestedSlugGrants: slugGrants
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(problemTitle(body));
      setPairingSecret(body as PairingSecret);
      router.refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  async function decide(pairing: SerializedPairingReview, decision: string) {
    setBusy(`pairing:${pairing.id}`);
    setError(null);
    try {
      const body =
        decision === "approve"
          ? {
              decision,
              grant: {
                scopes: pairing.requestedScopes,
                siteIds: [],
                slugGrants: pairing.requestedSlugGrants,
              },
              pairingId: pairing.id,
              protocolVersion: "1.0",
            }
          : {
              decision,
              pairingId: pairing.id,
              protocolVersion: "1.0",
            };
      await mutate(`/api/v1/pairing/sessions/${pairing.id}`, "PUT", body);
      router.refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  async function rename(connector: SerializedConnector, form: FormData) {
    setBusy(`connector:${connector.id}`);
    setError(null);
    try {
      await mutate(`/api/v1/connectors/${connector.id}`, "PATCH", {
        name: form.get("name"),
      });
      router.refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  async function revoke(connector: SerializedConnector) {
    setBusy(`connector:${connector.id}`);
    setError(null);
    try {
      await mutate(`/api/v1/connectors/${connector.id}`, "DELETE");
      router.refresh();
    } catch (caught) {
      setError(messageFrom(caught));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-4xl">
      <Badge variant="outline" className="mb-3 rounded-full">
        Connector access
      </Badge>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Connectors
      </h1>
      <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
        Review the identity and requested access of each local Knot runtime
        before it can use this workspace.
      </p>

      {error ? (
        <Alert variant="destructive" className="mt-6">
          <ShieldX />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {pairingSecret ? (
        <Alert className="mt-6">
          <KeyRound />
          <AlertTitle>Copy the one-time pairing credentials now</AlertTitle>
          <AlertDescription>
            <p>
              Knot Cloud stores only the token digest. The raw token will not be
              shown again.
            </p>
            <dl className="mt-3 grid gap-2 font-mono text-xs">
              <div>
                <dt className="font-sans font-medium text-foreground">
                  Pairing ID
                </dt>
                <dd className="mt-1 break-all">{pairingSecret.pairingId}</dd>
              </div>
              <div>
                <dt className="font-sans font-medium text-foreground">
                  Poll token
                </dt>
                <dd className="mt-1 break-all">{pairingSecret.pollToken}</dd>
              </div>
            </dl>
            <Button
              className="mt-3"
              size="sm"
              type="button"
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(
                  JSON.stringify({
                    authorizationUrl: pairingSecret.authorizationUrl,
                    pairingId: pairingSecret.pairingId,
                    pollToken: pairingSecret.pollToken,
                    protocolVersion: "1.0",
                  }),
                )
              }
            >
              <Copy />
              Copy credentials
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {canManage ? (
        <section className="mt-10 border-t pt-8">
          <h2 className="font-heading text-xl font-medium">
            Start a pairing request
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Enter the name and public key shown by the local connector. Its
            private key never leaves that machine.
          </p>
          <form className="mt-5 grid gap-5" onSubmit={createPairing}>
            <div className="grid gap-2 sm:grid-cols-2 sm:gap-4">
              <div className="space-y-2">
                <Label htmlFor="connector-name">Connector name</Label>
                <Input
                  id="connector-name"
                  maxLength={100}
                  placeholder="Raj's MacBook"
                  required
                  value={connectorName}
                  onChange={(event) => setConnectorName(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="connector-public-key">Public key</Label>
                <Input
                  id="connector-public-key"
                  className="font-mono text-xs"
                  pattern="[A-Za-z0-9_-]{43}"
                  placeholder="43-character base64url key"
                  required
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                />
              </div>
            </div>
            <fieldset>
              <legend className="text-sm font-medium">Requested scopes</legend>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {scopeNameSchema.options.map((scope) => (
                  <label
                    className="flex min-h-9 items-center gap-2 rounded-lg border px-3 py-2 text-sm"
                    key={scope}
                  >
                    <input
                      checked={selectedScopes.includes(scope)}
                      type="checkbox"
                      onChange={(event) =>
                        setSelectedScopes((current) =>
                          event.target.checked
                            ? [...current, scope]
                            : current.filter((value) => value !== scope),
                        )
                      }
                    />
                    <span className="font-mono text-xs">{scope}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="space-y-2">
              <Label htmlFor="connector-slugs">
                Slug grants <span className="font-normal">(optional)</span>
              </Label>
              <Input
                id="connector-slugs"
                placeholder="notes, projects/imai/*"
                value={slugGrants}
                onChange={(event) => setSlugGrants(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Separate grants with commas. A trailing /* permits descendants.
              </p>
            </div>
            <Button
              className="w-fit"
              disabled={busy !== null || selectedScopes.length === 0}
              type="submit"
            >
              {busy === "create" ? (
                <RefreshCw className="animate-spin" />
              ) : null}
              Create request
            </Button>
          </form>
        </section>
      ) : null}

      {canManage ? (
        <section className="mt-10 border-t pt-8">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="font-heading text-xl font-medium">
                Pairing requests
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Compare these values with the local connector before approval.
              </p>
            </div>
            <Badge variant="secondary">{pairings.length}</Badge>
          </div>
          <div className="mt-5 divide-y border-y">
            {pairings.length === 0 ? (
              <p className="py-6 text-sm text-muted-foreground">
                No pairing requests in this workspace.
              </p>
            ) : (
              pairings.map((pairing) => (
                <article className="py-6" key={pairing.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{pairing.connectorName}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Protocol {pairing.protocolVersion} · Expires{" "}
                        {formatDate(pairing.expiresAt)}
                      </p>
                    </div>
                    <Badge
                      variant={
                        pairing.status === "pending" ? "default" : "outline"
                      }
                    >
                      {pairing.status}
                    </Badge>
                  </div>
                  <dl className="mt-4 grid gap-4 text-sm">
                    <div>
                      <dt className="font-medium">Public key</dt>
                      <dd className="mt-1 break-all font-mono text-xs text-muted-foreground">
                        {pairing.publicKey}
                      </dd>
                    </div>
                    <div>
                      <dt className="font-medium">Requested scopes</dt>
                      <dd className="mt-2 flex flex-wrap gap-1.5">
                        {pairing.requestedScopes.map((scope) => (
                          <Badge key={scope} variant="outline">
                            {scope}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                    {pairing.requestedSlugGrants.length > 0 ? (
                      <div>
                        <dt className="font-medium">Requested slug grants</dt>
                        <dd className="mt-1 font-mono text-xs text-muted-foreground">
                          {pairing.requestedSlugGrants.join(", ")}
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                  {canManage && pairing.status === "pending" ? (
                    <div className="mt-5 flex gap-2">
                      <Button
                        disabled={busy !== null}
                        onClick={() => decide(pairing, "approve")}
                      >
                        <Check />
                        Approve exact request
                      </Button>
                      <Button
                        disabled={busy !== null}
                        variant="outline"
                        onClick={() => decide(pairing, "deny")}
                      >
                        Deny
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </div>
        </section>
      ) : null}

      <section className="mt-10 border-t pt-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h2 className="font-heading text-xl font-medium">
              Workspace connectors
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Revocation is permanent for a public key.
            </p>
          </div>
          <Badge variant="secondary">{connectors.length}</Badge>
        </div>
        <div className="mt-5 divide-y border-y">
          {connectors.length === 0 ? (
            <p className="py-6 text-sm text-muted-foreground">
              No connector has been approved.
            </p>
          ) : (
            connectors.map((connector) => (
              <article className="py-6" key={connector.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{connector.name}</h3>
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {connector.publicKey}
                    </p>
                  </div>
                  <Badge
                    variant={connector.revokedAt ? "destructive" : "outline"}
                  >
                    {connector.revokedAt ? "Revoked" : "Active"}
                  </Badge>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {connector.scopes.map((scope) => (
                    <Badge key={scope} variant="secondary">
                      {scope}
                    </Badge>
                  ))}
                </div>
                {canManage && !connector.revokedAt ? (
                  <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end">
                    <form
                      className="flex flex-1 items-end gap-2"
                      action={(form) => rename(connector, form)}
                    >
                      <div className="flex-1 space-y-2">
                        <Label htmlFor={`name-${connector.id}`}>
                          Display name
                        </Label>
                        <Input
                          defaultValue={connector.name}
                          id={`name-${connector.id}`}
                          maxLength={100}
                          name="name"
                          required
                        />
                      </div>
                      <Button
                        disabled={busy !== null}
                        type="submit"
                        variant="outline"
                      >
                        Rename
                      </Button>
                    </form>
                    <Button
                      disabled={busy !== null}
                      variant="destructive"
                      onClick={() => revoke(connector)}
                    >
                      Revoke
                    </Button>
                  </div>
                ) : null}
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

async function mutate(pathname: string, method: string, body?: unknown) {
  const response = await fetch(pathname, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    method,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(problemTitle(result));
  return result as unknown;
}

function problemTitle(value: unknown): string {
  if (
    value &&
    typeof value === "object" &&
    "title" in value &&
    typeof value.title === "string"
  ) {
    return value.title;
  }
  return "The server rejected the request.";
}

function messageFrom(value: unknown): string {
  return value instanceof Error ? value.message : "The request failed.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
