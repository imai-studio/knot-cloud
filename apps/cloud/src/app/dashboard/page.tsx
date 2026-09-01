import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
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
import { Brand } from "@/components/brand";
import { ConnectorsPanel } from "@/components/connectors-panel";
import {
  SitesPanel,
  type Publication,
  type Site,
} from "@/components/sites-panel";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { getAuthorizedSession } from "@/lib/auth";
import { NeonPublicationRepository } from "@/lib/adapters/neon-publications";
import { NeonConsumerDataRepository } from "@/lib/adapters/neon-consumer-data";
import { cn } from "@/lib/utils";
import { NeonPairingRepository } from "@/lib/adapters/neon-pairing";
import { canManageConnectors } from "@/lib/pairing";
import { getAuthorizedWorkspace } from "@/lib/workspace-auth";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const availableResources = [
  {
    detail: "Confirms the deployed service can answer requests.",
    href: "/api/health",
    label: "Service health",
    value: "Live endpoint",
  },
  {
    detail: "Returns the versioned protocol and capability manifest.",
    href: "/api/v1/meta",
    label: "Protocol metadata",
    value: "Versioned JSON",
  },
  {
    detail: "Prepare a local runtime using the released Knot CLI.",
    href: "https://github.com/imai-studio/knot/blob/main/docs/agent-setup.md",
    label: "Local Knot setup",
    value: "Operator guide",
  },
] as const;

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
  if (view === "sites") {
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

  return (
    <div className="min-h-screen bg-muted/35 lg:grid lg:grid-cols-[240px_1fr]">
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

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
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
              <ApiKeyManager initialKeys={apiKeys} />
            ) : (
              <section className="max-w-2xl rounded-2xl border bg-background p-6">
                <h1 className="font-heading text-2xl font-semibold">
                  API keys require owner access
                </h1>
                <p className="mt-2 leading-7 text-muted-foreground">
                  Workspace members cannot view key metadata or manage API
                  credentials. Ask a workspace owner to make this change.
                </p>
              </section>
            )
          ) : null}
          {view !== "overview" &&
          view !== "connectors" &&
          view !== "sites" &&
          view !== "api-keys" ? (
            <SectionEmptyState view={view} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function Overview() {
  return (
    <>
      <div className="max-w-3xl">
        <Badge variant="outline" className="mb-3 rounded-full">
          P0 foundation
        </Badge>
        <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
          Knot Cloud is online
        </h1>
        <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
          This build includes authenticated workspace access and connector
          pairing controls. Publishing and API-key issuance are not released
          yet.
        </p>
      </div>

      <section className="mt-10 max-w-4xl border-t pt-8">
        <h2 className="font-heading text-xl font-medium">Available now</h2>
        <div className="mt-5 divide-y border-y">
          {availableResources.map(({ detail, href, label, value }) => (
            <Link
              key={label}
              href={href}
              className="group grid gap-2 py-5 transition-colors hover:bg-muted/35 sm:grid-cols-[11rem_1fr_auto] sm:items-center sm:gap-6 sm:px-3"
            >
              <span className="font-medium">{label}</span>
              <span className="text-sm leading-6 text-muted-foreground">
                {detail}
              </span>
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
                {value}
                <ArrowUpRight className="size-4" strokeWidth={1.75} />
              </span>
            </Link>
          ))}
        </div>
      </section>

      <section className="mt-10 max-w-4xl border-t pt-7">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-primary" />
          <div>
            <h2 className="font-heading text-lg font-medium">
              Local authority stays local
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              The hosted foundation does not expose your Anytype, Heart, or
              agent listener. Signed identity, explicit scopes, and local policy
              remain the intended boundary for the next release.
            </p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
          {[
            "Signed connector identity",
            "Explicit permission scopes",
            "Local policy enforcement",
          ].map((item) => (
            <div key={item} className="flex items-center gap-2.5">
              <Check className="size-4 text-primary" strokeWidth={1.75} />
              <span>{item}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

const sectionCopy: Record<
  Exclude<DashboardView, "overview" | "connectors">,
  {
    description: string;
    detail: string;
    icon: typeof Bot;
    title: string;
  }
> = {
  sites: {
    description:
      "Publish selected Anytype objects without exposing your local listener.",
    detail:
      "Public publishing routes are not part of the current P0 release. No content has been published from this workspace.",
    icon: Globe2,
    title: "Sites",
  },
  "api-keys": {
    description: "Issue narrowly scoped credentials for the Knot data API.",
    detail:
      "API-key issuance is not part of the current P0 release. No credentials exist for this workspace.",
    icon: KeyRound,
    title: "API keys",
  },
  "audit-log": {
    description: "Review security-sensitive actions across your workspace.",
    detail:
      "There are no released connector or publishing operations to display yet. Activity will appear here as those routes become available.",
    icon: FileText,
    title: "Audit log",
  },
};

function SectionEmptyState({
  view,
}: {
  view: Exclude<DashboardView, "overview" | "connectors">;
}) {
  const { description, detail, icon: Icon, title } = sectionCopy[view];

  return (
    <div className="max-w-3xl">
      <Badge variant="outline" className="mb-3 rounded-full">
        P0 foundation
      </Badge>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
        {description}
      </p>

      <section className="mt-10 border-t pt-10">
        <div className="grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground">
          <Icon className="size-5" strokeWidth={1.75} />
        </div>
        <h2 className="mt-5 font-heading text-xl font-medium">
          Nothing to configure yet
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          {detail}
        </p>
        <Link
          href="https://github.com/imai-studio/knot-cloud#p0-contents"
          className={cn(
            buttonVariants({ variant: "outline" }),
            "mt-6 h-10 px-4 has-data-[icon=inline-end]:pr-4",
          )}
        >
          View release status
          <ArrowUpRight data-icon="inline-end" />
        </Link>
      </section>
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
