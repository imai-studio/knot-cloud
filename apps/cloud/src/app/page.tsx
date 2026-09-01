import { ArrowRight, Bot, Check, KeyRound, Radio, Send } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import { Brand, BrandMark } from "@/components/brand";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const capabilities = [
  {
    icon: Bot,
    title: "Agent connections",
    description:
      "Pair Codex or OpenClaw through a dedicated Anytype member without exposing a listener to the public internet.",
  },
  {
    icon: Send,
    title: "Removable publishing",
    description:
      "Turn Anytype objects into durable web pages, then remove both content and assets when you unpublish.",
  },
  {
    icon: KeyRound,
    title: "Scoped API access",
    description:
      "Issue revocable keys for the exact Anytype data and publishing operations each integration needs.",
  },
] as const;

export default function Home() {
  return (
    <div className="landing-light min-h-screen overflow-hidden bg-background text-foreground">
      <div className="paper-grid pointer-events-none absolute inset-x-0 top-0 h-[44rem]" />
      <header className="relative z-20 bg-background/82 backdrop-blur-xl">
        <div className="mx-auto flex h-18 max-w-7xl items-center justify-between px-5 sm:px-8">
          <Brand />
          <nav aria-label="Main navigation" className="flex items-center gap-2">
            <Link
              href="#how-it-works"
              className="hidden min-h-11 items-center rounded-full px-4 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:inline-flex"
            >
              How it works
            </Link>
            <Link
              href="/login"
              className={cn(
                buttonVariants({ variant: "outline" }),
                "h-11 rounded-full border-foreground/16 bg-background/70 px-5",
              )}
            >
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      <main className="relative">
        <section className="relative isolate mx-auto grid min-h-[calc(100svh-4.5rem)] max-w-7xl gap-12 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:gap-8 lg:py-20">
          <div className="relative z-10 max-w-3xl">
            <p className="mb-7 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Radio className="size-4 text-primary" strokeWidth={1.75} />
              Local agents, securely connected
            </p>
            <h1 className="max-w-3xl font-heading text-5xl leading-[1.01] font-semibold tracking-[-0.045em] text-balance sm:text-6xl lg:text-[4.6rem]">
              Your agents can work in Anytype. You keep the keys.
            </h1>
            <p className="mt-7 max-w-xl text-lg leading-[1.65] text-pretty text-muted-foreground sm:text-xl">
              Knot connects agents running on your machine to Anytype, gives
              them a controlled path to the web, and keeps every meaningful
              permission explicit.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link
                href="/login"
                className={cn(
                  buttonVariants({ size: "lg" }),
                  "h-11 gap-2 rounded-xl bg-foreground px-5 text-background shadow-none transition-[transform,background-color] has-data-[icon=inline-end]:pr-5 active:translate-y-0 active:scale-[0.96] hover:bg-foreground/90",
                )}
              >
                Open Knot
                <ArrowRight
                  data-icon="inline-end"
                  className="size-4 translate-x-px"
                  strokeWidth={1.75}
                />
              </Link>
              <a
                href="https://github.com/imai-studio/knot"
                className={cn(
                  buttonVariants({ variant: "outline", size: "lg" }),
                  "h-11 rounded-xl border-foreground/16 bg-background/70 px-5 shadow-none transition-transform active:translate-y-0 active:scale-[0.96]",
                )}
              >
                View the source
              </a>
            </div>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-3 text-sm text-muted-foreground">
              {[
                "Email-only access",
                "Self-hostable",
                "Private-by-default storage",
              ].map((item) => (
                <span key={item} className="inline-flex items-center gap-2">
                  <Check className="size-4 text-primary" strokeWidth={1.75} />
                  {item}
                </span>
              ))}
            </div>
          </div>

          <ControlPlanePreview />
        </section>

        <section id="how-it-works" className="relative scroll-mt-20">
          <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8 sm:py-32">
            <div className="max-w-3xl">
              <h2 className="font-display text-4xl leading-[1.08] font-medium tracking-[-0.035em] text-balance sm:text-5xl">
                Cloud coordination without surrendering local authority.
              </h2>
              <p className="mt-5 max-w-2xl text-base leading-7 text-pretty text-muted-foreground sm:text-lg sm:leading-8">
                The hosted service authenticates people, stores publication
                bundles, and queues typed work. Your local Knot connector still
                decides whether an agent may execute it.
              </p>
            </div>
            <div className="mt-16 grid gap-12 md:grid-cols-3 md:gap-8">
              {capabilities.map(({ icon: Icon, title, description }) => (
                <article
                  key={title}
                  className="border-t border-foreground/12 pt-6"
                >
                  <Icon className="size-5 text-primary" strokeWidth={1.6} />
                  <h3 className="mt-7 text-lg font-semibold tracking-[-0.02em]">
                    {title}
                  </h3>
                  <p className="mt-3 text-sm leading-6 text-pretty text-muted-foreground">
                    {description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="relative overflow-hidden px-5 py-24 sm:px-8 sm:py-32">
          <Image
            src="/art/knot-branch.webp"
            alt=""
            fill
            sizes="100vw"
            className="pointer-events-none -z-10 object-cover object-left opacity-48 mix-blend-multiply"
          />
          <div className="mx-auto max-w-3xl rounded-[2rem] border border-foreground/10 bg-background/82 px-6 py-12 text-center backdrop-blur-sm sm:px-12 sm:py-16">
            <p className="font-display text-3xl leading-tight font-medium tracking-[-0.03em] text-balance sm:text-5xl">
              Built for agents that need boundaries.
            </p>
            <Link
              href="/login"
              className={cn(
                buttonVariants({ size: "lg" }),
                "mt-8 h-11 gap-2 rounded-xl bg-foreground px-5 text-background shadow-none transition-[transform,background-color] has-data-[icon=inline-end]:pr-5 active:translate-y-0 active:scale-[0.96] hover:bg-foreground/90",
              )}
            >
              Open Knot
              <ArrowRight
                data-icon="inline-end"
                className="size-4 translate-x-px"
                strokeWidth={1.75}
              />
            </Link>
          </div>
        </section>
      </main>

      <footer className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-12 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>© {new Date().getFullYear()} imai. Knot is open source.</span>
        <span>Local authority, explicit permission.</span>
      </footer>
    </div>
  );
}

function ControlPlanePreview() {
  return (
    <div className="relative min-h-[31rem] lg:ml-auto lg:w-[120%] lg:max-w-[43rem]">
      <Image
        src="/art/knot-garden.png"
        alt=""
        fill
        sizes="(max-width: 1024px) 100vw, 55vw"
        className="landing-garden pointer-events-none object-cover object-[68%_center] opacity-90 mix-blend-multiply"
        priority
      />
      <div className="relative z-10 flex min-h-[31rem] items-center justify-center px-1 py-14 sm:px-8 lg:justify-end lg:px-0">
        <div className="w-full max-w-[34rem] rounded-[1.75rem] bg-card/88 p-5 ring-1 ring-foreground/10 backdrop-blur-md sm:p-7">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full bg-success" />
              Example workspace
            </div>
            <span className="text-xs text-muted-foreground">Illustrative</span>
          </div>

          <div className="mt-7 flex flex-col rounded-2xl bg-background/72 px-5 py-2 ring-1 ring-foreground/8 sm:flex-row sm:items-stretch sm:px-2 sm:py-5">
            <FlowStage
              eyebrow="Local"
              title="Codex"
              detail="Runs on your Mac"
            />
            <FlowConnector />
            <FlowStage
              eyebrow="Policy"
              title="Knot"
              detail="Identity and scope verified"
              mark
            />
            <FlowConnector />
            <FlowStage
              eyebrow="Origin"
              title="Private R2"
              detail="Published on approval"
            />
          </div>

          <p className="mt-6 max-w-md text-sm leading-6 text-pretty text-muted-foreground">
            The cloud coordinates intent. Your local connector keeps the final
            say.
          </p>
        </div>
      </div>
    </div>
  );
}

function FlowStage({
  eyebrow,
  title,
  detail,
  mark = false,
}: {
  eyebrow: string;
  title: string;
  detail: string;
  mark?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-4 py-4 sm:flex-col sm:items-start sm:justify-between sm:gap-8 sm:px-3 sm:py-2">
      <div className="flex w-full items-center justify-between gap-3">
        <span className="text-[11px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
          {eyebrow}
        </span>
        {mark ? <BrandMark className="size-9" /> : null}
      </div>
      <div className="min-w-0">
        <p className="text-lg font-semibold tracking-[-0.025em]">{title}</p>
        <p className="mt-1 text-xs leading-5 text-pretty text-muted-foreground">
          {detail}
        </p>
      </div>
    </div>
  );
}

function FlowConnector() {
  return (
    <div className="grid h-8 shrink-0 place-items-center text-muted-foreground sm:h-auto sm:w-8">
      <ArrowRight className="size-4 rotate-90 sm:rotate-0" strokeWidth={1.5} />
    </div>
  );
}
