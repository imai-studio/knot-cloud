"use client";

import {
  Check,
  Copy,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";

import type { Site } from "@/components/sites-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type PlatformData = {
  capabilities: {
    customDomains: Capability;
    authenticatedReaders: Capability;
    mediaDerivatives: Capability;
    hostedConnectors: Capability;
    billing: Capability;
  };
  usage: Record<
    | "sites"
    | "customDomains"
    | "readerGrants"
    | "apiKeys"
    | "connectors"
    | "storageBytes"
    | "derivativeJobs",
    { used: number; limit: number }
  >;
};

type Capability = { available: boolean; reasonCode?: string };
type Domain = {
  id: string;
  hostname: string;
  status: "pending" | "verified" | "failed" | "disabled";
  dnsName?: string;
  dnsValue?: string;
  lastErrorCode?: string;
  lastCheckedAt?: string;
  challengeExpiresAt: string;
};
type ReaderGrant = {
  id: string;
  label: string;
  expiresAt: string;
  maxRedemptions: number;
  redemptionCount: number;
  revokedAt?: string;
};

export function PlatformPanel({ sites }: { sites: Site[] }) {
  const [selectedSiteId, setSelectedSiteId] = useState(sites[0]?.id);
  const [platform, setPlatform] = useState<PlatformData>();
  const [readerAccess, setReaderAccess] = useState<"public" | "authenticated">(
    "public",
  );
  const [domains, setDomains] = useState<Domain[]>([]);
  const [grants, setGrants] = useState<ReaderGrant[]>([]);
  const [oneTimeToken, setOneTimeToken] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(Boolean(sites[0]?.id));

  useEffect(() => {
    void loadPlatform();
  }, []);

  useEffect(() => {
    if (!selectedSiteId) return;
    let cancelled = false;
    void Promise.all([
      fetch(`/api/v1/session/sites/${selectedSiteId}/access`, {
        cache: "no-store",
      }),
      fetch(`/api/v1/session/sites/${selectedSiteId}/domains`, {
        cache: "no-store",
      }),
      fetch(`/api/v1/session/sites/${selectedSiteId}/reader-grants`, {
        cache: "no-store",
      }),
    ])
      .then(async ([accessResponse, domainResponse, grantResponse]) => {
        if (cancelled) return;
        if (accessResponse.ok) {
          setReaderAccess(
            (
              (await accessResponse.json()) as {
                readerAccess: typeof readerAccess;
              }
            ).readerAccess,
          );
        }
        if (domainResponse.ok) {
          setDomains((await domainResponse.json()) as Domain[]);
        }
        if (grantResponse.ok) {
          setGrants((await grantResponse.json()) as ReaderGrant[]);
        }
        setPending(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPending(false);
          setMessage("Site access settings could not be loaded.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSiteId]);

  async function loadPlatform() {
    const response = await fetch("/api/v1/session/platform", {
      cache: "no-store",
    });
    if (response.ok) setPlatform((await response.json()) as PlatformData);
  }

  async function setAccess(next: "public" | "authenticated") {
    if (!selectedSiteId) return;
    setMessage(undefined);
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/access`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ readerAccess: next }),
      },
    );
    if (!response.ok) {
      setMessage("Reader access could not be changed.");
      return;
    }
    setReaderAccess(next);
    setMessage(
      next === "authenticated"
        ? "A valid reader session is now required. Create a grant before sharing the site."
        : "The site is public again.",
    );
  }

  async function addDomain(formData: FormData) {
    if (!selectedSiteId) return;
    setMessage(undefined);
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/domains`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostname: formData.get("hostname") }),
      },
    );
    if (!response.ok) {
      setMessage(
        response.status === 503
          ? "Custom-domain verification is not configured on this deployment."
          : "That domain could not be added. Check the hostname and workspace limit.",
      );
      return;
    }
    const domain = (await response.json()) as Domain;
    setDomains((current) => [domain, ...current]);
    setMessage("Add the exact TXT record shown below, then verify it.");
    void loadPlatform();
  }

  async function verifyDomain(domainId: string) {
    if (!selectedSiteId) return;
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/domains/${domainId}/verify`,
      { method: "POST" },
    );
    if (response.ok) {
      const domain = (await response.json()) as Domain;
      setDomains((current) =>
        current.map((candidate) =>
          candidate.id === domain.id ? { ...candidate, ...domain } : candidate,
        ),
      );
      setMessage(
        domain.status === "verified"
          ? "Domain ownership verified. DNS routing remains under your control."
          : "The TXT challenge is not visible yet. DNS can take time to propagate.",
      );
    } else setMessage("The DNS check could not be completed.");
  }

  async function disableDomain(domainId: string) {
    if (!selectedSiteId) return;
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/domains/${domainId}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      setDomains((current) =>
        current.map((domain) =>
          domain.id === domainId ? { ...domain, status: "disabled" } : domain,
        ),
      );
      void loadPlatform();
    }
  }

  async function createGrant(formData: FormData) {
    if (!selectedSiteId) return;
    setOneTimeToken(undefined);
    const days = Number(formData.get("days"));
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/reader-grants`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: formData.get("label"),
          expiresAt: new Date(Date.now() + days * 86_400_000).toISOString(),
          maxRedemptions: Number(formData.get("maxRedemptions")),
        }),
      },
    );
    if (!response.ok) {
      setMessage("The reader grant could not be created.");
      return;
    }
    const grant = (await response.json()) as ReaderGrant & { token: string };
    setOneTimeToken(grant.token);
    setGrants((current) => [{ ...grant, token: undefined }, ...current]);
    setMessage("Copy the grant now. Knot will not show it again.");
    void loadPlatform();
  }

  async function revokeGrant(grantId: string) {
    if (!selectedSiteId) return;
    const response = await fetch(
      `/api/v1/session/sites/${selectedSiteId}/reader-grants/${grantId}`,
      { method: "DELETE" },
    );
    if (response.ok) {
      setGrants((current) =>
        current.map((grant) =>
          grant.id === grantId
            ? { ...grant, revokedAt: new Date().toISOString() }
            : grant,
        ),
      );
      setMessage("Grant and its reader sessions were revoked.");
      void loadPlatform();
    }
  }

  return (
    <div className="max-w-5xl">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Access and domains
      </h1>
      <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
        Decide who can read a site, verify a domain you control, and see the
        limits the server enforces before a write is accepted.
      </p>

      {platform ? <Usage platform={platform} /> : null}

      {sites.length === 0 ? (
        <p className="mt-8 border-y py-6 text-sm text-muted-foreground">
          Create a site first. Access policy and domains belong to a specific
          site.
        </p>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap gap-2 border-y py-4">
            {sites.map((site) => (
              <Button
                key={site.id}
                type="button"
                size="sm"
                variant={selectedSiteId === site.id ? "default" : "ghost"}
                onClick={() => {
                  if (selectedSiteId !== site.id) {
                    setPending(true);
                    setSelectedSiteId(site.id);
                  }
                }}
              >
                <Globe2 />
                {site.name}
              </Button>
            ))}
            {pending ? (
              <LoaderCircle className="ml-auto size-4 animate-spin self-center text-muted-foreground" />
            ) : null}
          </div>

          {message ? (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {message}
            </p>
          ) : null}

          <section className="mt-9 grid gap-6 border-b pb-9 md:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="text-lg font-semibold">Reader access</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Public sites need no credential. Authenticated sites accept only
                a live reader session created from a grant.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 md:justify-end">
              <Button
                type="button"
                variant={readerAccess === "public" ? "default" : "outline"}
                onClick={() => void setAccess("public")}
              >
                Public
              </Button>
              <Button
                type="button"
                variant={
                  readerAccess === "authenticated" ? "default" : "outline"
                }
                onClick={() => void setAccess("authenticated")}
              >
                <LockKeyhole /> Authenticated
              </Button>
            </div>
          </section>

          <section className="grid gap-8 border-b py-9 md:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="text-lg font-semibold">Custom domains</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Knot verifies an exact TXT challenge. It never edits your DNS.
              </p>
              <form action={addDomain} className="mt-5 space-y-3">
                <Label htmlFor="custom-hostname">Bare hostname</Label>
                <div className="flex gap-2">
                  <Input
                    id="custom-hostname"
                    name="hostname"
                    placeholder="notes.example.com"
                    disabled={!platform?.capabilities.customDomains.available}
                    required
                  />
                  <Button
                    type="submit"
                    disabled={!platform?.capabilities.customDomains.available}
                  >
                    Add
                  </Button>
                </div>
                {platform && !platform.capabilities.customDomains.available ? (
                  <p className="text-xs leading-5 text-muted-foreground">
                    This deployment has no domain challenge secret. Existing
                    mappings can still be disabled, but new challenges cannot be
                    created or verified.
                  </p>
                ) : null}
              </form>
            </div>
            <div className="divide-y border-y">
              {domains.length === 0 ? (
                <p className="py-5 text-sm text-muted-foreground">
                  No domains are attached to this site.
                </p>
              ) : (
                domains.map((domain) => (
                  <div key={domain.id} className="py-5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-medium">{domain.hostname}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {domain.status === "verified"
                            ? "Verified"
                            : domain.status === "disabled"
                              ? "Disabled"
                              : "TXT verification required"}
                        </p>
                      </div>
                      {domain.status !== "disabled" ? (
                        <div className="flex gap-1">
                          {domain.status !== "verified" ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => void verifyDomain(domain.id)}
                            >
                              <RefreshCw /> Verify
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Disable ${domain.hostname}`}
                            onClick={() => void disableDomain(domain.id)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    {domain.dnsName && domain.dnsValue ? (
                      <dl className="mt-4 grid gap-2 text-xs">
                        <div>
                          <dt className="text-muted-foreground">TXT name</dt>
                          <dd className="mt-1 break-all font-mono">
                            {domain.dnsName}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">TXT value</dt>
                          <dd className="mt-1 break-all font-mono">
                            {domain.dnsValue}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">
                            Challenge expires
                          </dt>
                          <dd className="mt-1">
                            {formatDate(domain.challengeExpiresAt)}
                          </dd>
                        </div>
                      </dl>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="grid gap-8 py-9 md:grid-cols-[1fr_1.4fr]">
            <div>
              <h2 className="text-lg font-semibold">Reader grants</h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Each grant has an expiry and redemption cap. Revoking it also
                revokes every session it created.
              </p>
              <form action={createGrant} className="mt-5 space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="grant-label">Label</Label>
                  <Input
                    id="grant-label"
                    name="label"
                    placeholder="Review team"
                    required
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="grant-days">Days</Label>
                    <Input
                      id="grant-days"
                      name="days"
                      type="number"
                      min="1"
                      max="365"
                      defaultValue="7"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="grant-redemptions">Readers</Label>
                    <Input
                      id="grant-redemptions"
                      name="maxRedemptions"
                      type="number"
                      min="1"
                      max="100"
                      defaultValue="1"
                      required
                    />
                  </div>
                </div>
                <Button type="submit">Create grant</Button>
              </form>
            </div>
            <div>
              {oneTimeToken ? (
                <div className="mb-5 border-y py-4">
                  <p className="text-sm font-medium">Copy this grant now</p>
                  <div className="mt-2 flex items-start gap-2">
                    <code className="min-w-0 flex-1 break-all text-xs">
                      {oneTimeToken}
                    </code>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Copy reader grant"
                      onClick={() =>
                        void navigator.clipboard.writeText(oneTimeToken)
                      }
                    >
                      <Copy />
                    </Button>
                  </div>
                </div>
              ) : null}
              <div className="divide-y border-y">
                {grants.length === 0 ? (
                  <p className="py-5 text-sm text-muted-foreground">
                    No reader grants exist for this site.
                  </p>
                ) : (
                  grants.map((grant) => {
                    const active =
                      !grant.revokedAt &&
                      new Date(grant.expiresAt) > new Date();
                    return (
                      <div
                        key={grant.id}
                        className="flex items-center justify-between gap-4 py-4"
                      >
                        <div>
                          <p className="font-medium">{grant.label}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {grant.redemptionCount}/{grant.maxRedemptions} used
                            · expires {formatDate(grant.expiresAt)}
                          </p>
                        </div>
                        {active ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={() => void revokeGrant(grant.id)}
                          >
                            Revoke
                          </Button>
                        ) : (
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Check className="size-3" /> Inactive
                          </span>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Usage({ platform }: { platform: PlatformData }) {
  const rows = [
    ["Sites", platform.usage.sites],
    ["Custom domains", platform.usage.customDomains],
    ["Reader grants", platform.usage.readerGrants],
    ["Connectors", platform.usage.connectors],
    ["API keys", platform.usage.apiKeys],
    ["Storage", platform.usage.storageBytes, true],
  ] as const;
  return (
    <section className="mt-9 border-y py-5">
      <h2 className="text-sm font-medium">Workspace limits</h2>
      <dl className="mt-4 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map(([label, value, bytes]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-4"
          >
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="font-mono text-xs">
              {bytes ? formatBytes(value.used) : value.used} /{" "}
              {bytes ? formatBytes(value.limit) : value.limit}
            </dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-xs leading-5 text-muted-foreground">
        Media derivatives, hosted connectors, and billing remain disabled until
        their provider, licensing, and key-management boundaries are configured.
      </p>
    </section>
  );
}

function formatBytes(value: number) {
  return `${(value / 1_048_576).toFixed(value < 10_485_760 ? 1 : 0)} MiB`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(value),
  );
}
