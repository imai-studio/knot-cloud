import {
  Activity,
  ArrowUpRight,
  Bot,
  FileText,
  Globe2,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountMenu } from "@/components/account-menu";
import { ApiKeyManager } from "@/components/api-key-manager";
import {
  AuditLogPanel,
  type SerializedAuditPage,
} from "@/components/audit-log-panel";
import { Brand } from "@/components/brand";
import { ConnectorsPanel } from "@/components/connectors-panel";
import { PlatformPanel } from "@/components/platform-panel";
import {
  SitesPanel,
  type Publication,
  type Site,
} from "@/components/sites-panel";
import { getAuthorizedSession } from "@/lib/auth";
import { NeonAuditRepository } from "@/lib/adapters/neon-audit";
import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { NeonConsumerDataRepository } from "@/lib/adapters/neon-consumer-data";
import { cn } from "@/lib/utils";
import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const navItems = [
  { href: "/dashboard", icon: Activity, id: "overview", label: "Overview" },
  {
    href: "/dashboard?view=connectors",
    icon: Bot,
    id: "connectors",
    label: "Connectors",
  },
  {
    href: "/dashboard?view=sites",
    icon: Globe2,
    id: "sites",
    label: "Sites",
  },
  {
    href: "/dashboard?view=api-keys",
    icon: KeyRound,
    id: "api-keys",
    label: "API keys",
  },
  {
    href: "/dashboard?view=access",
    icon: ShieldCheck,
    id: "access",
    label: "Access & domains",
  },
  {
    href: "/dashboard?view=audit-log",
    icon: FileText,
    id: "audit-log",
    label: "Audit log",
  },
] as const;

type DashboardView = (typeof navItems)[number]["id"];

function resolveDashboardView(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return navItems.some((item) => item.id === candidate)
    ? (candidate as DashboardView)
    : "overview";
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const requestHeaders = await headers();
  const authorized = await getAuthorizedWorkspace(requestHeaders);
  if (!authorized) {
    const identity = await getAuthorizedSession(requestHeaders);
    if (!identity) redirect("/login");
    return (
      <main className="min-h-dvh bg-muted/35 px-5 py-5 sm:px-8 sm:py-7">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <Brand href="/dashboard" />
          <AccountMenu email={identity.user.email} name={identity.user.name} />
        </div>
        <section className="mx-auto mt-24 max-w-xl rounded-2xl border bg-background p-8 sm:p-10">
          <p className="text-sm font-medium text-muted-foreground">
            Workspace unavailable
          </p>
          <h1 className="mt-3 font-heading text-4xl font-medium tracking-tight">
            This account has no active workspace.
          </h1>
          <p className="mt-4 leading-7 text-muted-foreground">
            Ask the Knot operator to restore a workspace or add this account to
            an active one.
          </p>
        </section>
      </main>
    );
  }
  const view = resolveDashboardView((await searchParams).view);
  const activeItem = navItems.find((item) => item.id === view) ?? navItems[0];
  const manageConnectors = canManageConnectors(authorized);
  const connectorData =
    view === "connectors"
      ? await loadConnectorData(authorized.workspace.tenantId, manageConnectors)
      : null;
  let initialSites: Site[] = [];
  let initialPublications: Publication[] = [];
  if (view === "sites" || view === "access") {
    const repository = new NeonPublicationRepository();
    initialSites = await repository.listSites(authorized.workspace.tenantId);
    const firstSite = initialSites[0];
    if (firstSite) {
      initialPublications = await repository.listPublications({
        tenantId: authorized.workspace.tenantId,
        siteId: firstSite.id,
      });
    }
  }
  const apiKeys =
    view === "api-keys" && manageConnectors
      ? await new NeonConsumerDataRepository().listApiKeys(
          authorized.workspace.tenantId,
        )
      : [];
  const apiKeyConnectors =
    view === "api-keys" && manageConnectors
      ? await new NeonPairingRepository().listConnectors(
          authorized.workspace.tenantId,
        )
      : [];
  let auditPage: SerializedAuditPage | null = null;
  if (view === "audit-log" && manageConnectors) {
    const page = await new NeonAuditRepository().list(
      authorized.workspace.tenantId,
      { limit: 25 },
    );
    auditPage = {
      events: page.events.map((event) => ({
        ...event,
        createdAt: event.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[240px_1fr]">
      <a
        href="#dashboard-content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-offset-2 focus:outline-ring"
      >
        Skip to dashboard content
      </a>
      <aside className="hidden border-r bg-sidebar lg:flex lg:min-h-screen lg:flex-col">
        <div className="flex h-16 items-center border-b px-5">
          <Brand href="/dashboard" />
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Dashboard navigation">
          {navItems.map(({ href, icon: Icon, id, label }) => {
            const active = id === view;
            return (
              <Link
                key={label}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/55 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-4" />
                {label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <Brand className="lg:hidden" href="/dashboard" />
          <div className="hidden lg:block">
            <p className="text-sm font-medium">{activeItem.label}</p>
            <p className="text-xs text-muted-foreground">
              {authorized.workspace.name}
            </p>
          </div>
          <AccountMenu
            email={authorized.identity.user.email}
            name={authorized.identity.user.name}
          />
        </header>

        <nav
          className="flex gap-1 overflow-x-auto border-b bg-background px-3 py-2 lg:hidden"
          aria-label="Dashboard navigation"
        >
          {navItems.map(({ href, id, label }) => {
            const active = id === view;
            return (
              <Link
                key={id}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
        </nav>

        <main
          id="dashboard-content"
          className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10"
        >
          {view === "overview" ? <Overview /> : null}
          {view === "connectors" ? (
            connectorData ? (
              <ConnectorsPanel
                canManage={manageConnectors}
                connectors={connectorData.connectors}
                pairings={connectorData.pairings}
                sites={connectorData.sites}
              />
            ) : null
          ) : null}
          {view === "sites" ? (
            <SitesPanel
              initialPublications={initialPublications}
              initialSites={initialSites}
            />
          ) : null}
          {view === "api-keys" ? (
            manageConnectors ? (
              <ApiKeyManager
                connectors={apiKeyConnectors.map((connector) => ({
                  id: connector.id,
                  name: connector.name,
                  revokedAt: connector.revokedAt?.toISOString() ?? null,
                  scopes: connector.scopes,
                }))}
                initialKeys={apiKeys}
              />
            ) : (
              <RestrictedSection title="API keys" />
            )
          ) : null}
          {view === "access" ? (
            manageConnectors ? (
              <PlatformPanel sites={initialSites} />
            ) : (
              <RestrictedSection title="Access and domains" />
            )
          ) : null}
          {view === "audit-log" ? (
            auditPage && manageConnectors ? (
              <AuditLogPanel initialPage={auditPage} />
            ) : (
              <RestrictedSection title="Audit log" />
            )
          ) : null}
        </main>
      </div>
    </div>
  );
}

function RestrictedSection({ title }: { title: string }) {
  return (
    <div className="max-w-2xl border-y py-8">
      <h1 className="font-heading text-3xl font-semibold tracking-tight">
        {title}
      </h1>
      <p className="mt-3 leading-7 text-muted-foreground">
        Ask a workspace owner or admin to manage this section.
      </p>
    </div>
  );
}

function Overview() {
  return (
    <div className="max-w-4xl">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Connect local Knot, then choose what it can do
      </h1>
      <p className="mt-3 max-w-2xl leading-7 text-muted-foreground">
        Cloud access does not grant access to Anytype or your machine. Your
        local Knot keeps that authority and enforces its own policy.
      </p>
      <ol className="mt-9 divide-y border-y">
        {[
          {
            href: "/dashboard?view=connectors",
            label: "Pair a local connector",
            detail:
              "Verify its public key, choose exact scopes, and approve the request.",
          },
          {
            href: "/dashboard?view=sites",
            label: "Create a publishing site",
            detail:
              "Give selected publications a stable site and review their version history.",
          },
          {
            href: "/dashboard?view=api-keys",
            label: "Issue a scoped API key",
            detail:
              "Bind the key to known connectors, set an expiry, and keep the secret once.",
          },
          {
            href: "/dashboard?view=access",
            label: "Set reader access and domains",
            detail:
              "Issue revocable reader grants, verify DNS ownership, and inspect enforced limits.",
          },
          {
            href: "/dashboard?view=audit-log",
            label: "Review workspace activity",
            detail:
              "Filter security-sensitive actions without exposing credentials.",
          },
        ].map((item, index) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="group grid gap-2 py-5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:grid-cols-[2rem_14rem_1fr_auto] sm:items-center sm:gap-4"
            >
              <span className="font-mono text-sm text-muted-foreground">
                {index + 1}
              </span>
              <span className="font-medium">{item.label}</span>
              <span className="text-sm leading-6 text-muted-foreground">
                {item.detail}
              </span>
              <ArrowUpRight className="size-4" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ol>
      <p className="mt-6 text-sm leading-6 text-muted-foreground">
        Need the local setup steps? Read the{" "}
        <Link
          className="font-medium text-foreground underline underline-offset-4"
          href="https://github.com/imai-studio/knot/blob/main/docs/agent-setup.md"
        >
          local Knot setup guide
        </Link>
        .
      </p>
    </div>
  );
}

async function loadConnectorData(tenantId: string, includeReviews: boolean) {
  const repository = new NeonPairingRepository();
  const [connectors, pairings, sites] = await Promise.all([
    repository.listConnectors(tenantId),
    includeReviews ? repository.listReviews(tenantId) : Promise.resolve([]),
    repository.listSites(tenantId),
  ]);
  return {
    connectors: connectors.map((connector) => ({
      ...connector,
      createdAt: connector.createdAt.toISOString(),
      lastSeenAt: connector.lastSeenAt?.toISOString() ?? null,
      revokedAt: connector.revokedAt?.toISOString() ?? null,
    })),
    pairings: pairings.map((pairing) => ({
      ...pairing,
      createdAt: pairing.createdAt.toISOString(),
      expiresAt: pairing.expiresAt.toISOString(),
      approvedAt: pairing.approvedAt?.toISOString() ?? null,
      deniedAt: pairing.deniedAt?.toISOString() ?? null,
      pollConsumedAt: pairing.pollConsumedAt?.toISOString() ?? null,
      resultExpired: pairing.expiresAt.getTime() <= Date.now(),
    })),
    sites,
  };
}
