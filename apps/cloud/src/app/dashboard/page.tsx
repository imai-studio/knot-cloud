import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  CircleDashed,
  Code2,
  FileText,
  Globe2,
  KeyRound,
  Plus,
} from "lucide-react";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { AccountMenu } from "@/components/account-menu";
import { Brand } from "@/components/brand";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAuthorizedSession } from "@/lib/auth";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

const metrics = [
  { icon: Bot, label: "Connectors", value: "0", detail: "No agents paired" },
  {
    icon: Globe2,
    label: "Published sites",
    value: "0",
    detail: "Nothing live yet",
  },
  { icon: KeyRound, label: "API keys", value: "0", detail: "No active keys" },
] as const;

const navItems = [
  { icon: Activity, label: "Overview", active: true },
  { icon: Bot, label: "Connectors", active: false },
  { icon: Globe2, label: "Sites", active: false },
  { icon: KeyRound, label: "API keys", active: false },
  { icon: FileText, label: "Audit log", active: false },
] as const;

export default async function DashboardPage() {
  const session = await getAuthorizedSession(await headers());
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-muted/35 lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="hidden border-r bg-sidebar lg:flex lg:min-h-screen lg:flex-col">
        <div className="flex h-16 items-center border-b px-5">
          <Brand href="/dashboard" />
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Dashboard navigation">
          {navItems.map(({ icon: Icon, label, active }) => (
            <button
              key={label}
              type="button"
              disabled={!active}
              className={cn(
                "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 text-left text-sm font-medium transition-colors",
                active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="border-t p-4">
          <div className="rounded-lg border bg-background p-3">
            <div className="flex items-center gap-2 text-xs font-medium">
              <span className="size-2 rounded-full bg-primary/70" />
              Infrastructure configured
            </div>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
              Live health checks will appear here when monitoring is enabled.
            </p>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/90 px-4 backdrop-blur-xl sm:px-6 lg:px-8">
          <Brand className="lg:hidden" href="/dashboard" />
          <div className="hidden lg:block">
            <p className="text-sm font-medium">Workspace overview</p>
            <p className="text-xs text-muted-foreground">imai</p>
          </div>
          <AccountMenu email={session.user.email} name={session.user.name} />
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <Badge variant="outline" className="mb-3 rounded-full">
                Private beta
              </Badge>
              <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
                Welcome to Knot
              </h1>
              <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
                Connect a local agent, then publish Anytype objects or issue
                scoped API access from one place.
              </p>
            </div>
            <Link
              href="https://github.com/imai-studio/knot/blob/main/docs/agent-setup.md"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-10 px-4",
              )}
            >
              Setup guide
              <ArrowUpRight data-icon="inline-end" />
            </Link>
          </div>

          <section
            className="mt-8 grid gap-4 sm:grid-cols-3"
            aria-label="Workspace metrics"
          >
            {metrics.map(({ icon: Icon, label, value, detail }) => (
              <Card key={label}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="grid size-9 place-items-center rounded-lg bg-secondary">
                      <Icon className="size-4" />
                    </div>
                    <span className="font-heading text-3xl font-semibold tracking-tight">
                      {value}
                    </span>
                  </div>
                  <CardTitle className="mt-3">{label}</CardTitle>
                  <CardDescription>{detail}</CardDescription>
                </CardHeader>
              </Card>
            ))}
          </section>

          <section className="mt-4 grid gap-4 lg:grid-cols-[1.25fr_0.75fr]">
            <Card>
              <CardHeader>
                <CardTitle className="font-heading text-xl">
                  Get connected
                </CardTitle>
                <CardDescription>
                  Three deliberate steps from local runtime to usable workspace.
                </CardDescription>
                <CardAction>
                  <Badge variant="secondary">1 of 3</Badge>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ol className="space-y-1">
                  <OnboardingStep
                    icon={Code2}
                    title="Install Knot locally"
                    description="Run the CLI beside the agent you want to connect."
                    status="current"
                  />
                  <OnboardingStep
                    icon={Bot}
                    title="Pair a connector"
                    description="Authenticate the local runtime with this workspace."
                  />
                  <OnboardingStep
                    icon={Globe2}
                    title="Publish your first object"
                    description="Choose what goes live and retain the ability to remove it."
                  />
                </ol>
              </CardContent>
            </Card>

            <Card className="relative overflow-hidden bg-[#30283a] text-[#fffdfa]">
              <Image
                src="/art/knot-auth-bloom.png"
                alt=""
                width={280}
                height={280}
                className="pointer-events-none absolute -right-16 -bottom-20 size-64 opacity-16"
              />
              <CardHeader>
                <CardTitle className="relative font-heading text-xl text-[#fffdfa]">
                  Local-first by design
                </CardTitle>
                <CardDescription className="relative text-[#fffdfa]/60">
                  Cloud coordination never becomes ambient machine access.
                </CardDescription>
              </CardHeader>
              <CardContent className="relative space-y-4">
                {[
                  "Signed connector identity",
                  "Explicit permission scopes",
                  "Local policy enforcement",
                ].map((item) => (
                  <div key={item} className="flex items-center gap-3 text-sm">
                    <span className="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3.5" />
                    </span>
                    {item}
                  </div>
                ))}
              </CardContent>
            </Card>
          </section>
        </main>
      </div>
    </div>
  );
}

function OnboardingStep({
  description,
  icon: Icon,
  status,
  title,
}: {
  description: string;
  icon: typeof Code2;
  status?: "current";
  title: string;
}) {
  return (
    <li className="flex gap-4 rounded-xl p-3">
      <div
        className={cn(
          "grid size-10 shrink-0 place-items-center rounded-lg border",
          status === "current"
            ? "border-primary/20 bg-accent text-accent-foreground"
            : "bg-muted text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex items-center gap-2">
          <p className="font-medium">{title}</p>
          {status === "current" ? <Badge>Start here</Badge> : null}
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {status === "current" ? (
        <Plus className="mt-2 size-4 text-primary" />
      ) : (
        <CircleDashed className="mt-2 size-4 text-muted-foreground" />
      )}
    </li>
  );
}
