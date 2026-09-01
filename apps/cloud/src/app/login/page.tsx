import type { Metadata } from "next";
import { headers } from "next/headers";
import Image from "next/image";
import { redirect } from "next/navigation";

import { Brand } from "@/components/brand";
import { getAuthorizedSession } from "@/lib/auth";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Sign in",
};
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const session = await getAuthorizedSession(await headers());
  if (session) redirect("/dashboard");

  const { error } = await searchParams;
  const initialError = error
    ? "That sign-in link is invalid or has expired. Request a new one."
    : undefined;

  return (
    <main className="relative grid min-h-dvh lg:grid-cols-[0.9fr_1.1fr]">
      <section className="flex min-h-dvh flex-col px-5 py-5 sm:px-8 sm:py-7">
        <Brand />
        <div className="flex flex-1 items-center justify-center py-12">
          <LoginForm initialError={initialError} />
        </div>
        <p className="text-center text-xs text-muted-foreground">
          Secure, passwordless access · Links expire after 10 minutes
        </p>
      </section>
      <aside className="relative hidden overflow-hidden border-l bg-[#f7f1f8] p-12 text-[#332c40] lg:flex lg:flex-col lg:justify-between">
        <Image
          src="/art/knot-garden.png"
          alt=""
          fill
          sizes="55vw"
          className="object-cover object-center"
          priority
        />
        <div className="absolute inset-0 bg-gradient-to-r from-[#fcfaf7]/92 via-[#fcfaf7]/38 to-transparent" />
        <div className="relative max-w-lg">
          <p className="text-sm font-medium text-[#7654a3]">Knot Cloud</p>
          <h1 className="mt-5 font-heading text-5xl leading-[1.02] font-medium tracking-[-0.035em] text-balance">
            A control plane that respects where authority lives.
          </h1>
          <p className="mt-6 max-w-md text-lg leading-8 text-[#70677a]">
            Connect your local agents, publish from Anytype, and manage access
            without handing a remote service unrestricted control of your
            machine.
          </p>
        </div>
        <div className="relative rounded-2xl border border-[#e3dae6] bg-[#fffdfa]/82 p-2 backdrop-blur-sm">
          <div className="rounded-xl border border-[#e3dae6]/80 bg-[#fffdfa]/85 p-5">
            <p className="font-mono text-xs text-[#70677a]">policy.log</p>
            <div className="mt-4 space-y-3 text-sm">
              <p className="flex items-center justify-between gap-4">
                <span className="text-[#70677a]">Identity verified</span>
                <span className="font-mono text-[#4f6b54]">pass</span>
              </p>
              <p className="flex items-center justify-between gap-4">
                <span className="text-[#70677a]">Local policy</span>
                <span className="font-mono text-[#4f6b54]">enforced</span>
              </p>
              <p className="flex items-center justify-between gap-4">
                <span className="text-[#70677a]">Public listener</span>
                <span className="font-mono text-[#70677a]">none</span>
              </p>
            </div>
          </div>
        </div>
      </aside>
    </main>
  );
}
