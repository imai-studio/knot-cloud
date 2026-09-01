import type { Metadata } from "next";

import { safeReaderReturnPath } from "@/lib/reader-access";

import { ReaderAccessForm } from "./reader-access-form";

export const metadata: Metadata = { title: "Reader access · Knot" };

export default async function ReaderAccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ siteSlug: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { siteSlug } = await params;
  const requestedNext = (await searchParams).next;
  const next = Array.isArray(requestedNext) ? requestedNext[0] : requestedNext;
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-5 py-12">
      <section className="w-full max-w-md border-y py-8">
        <p className="text-sm font-medium text-muted-foreground">
          Private Knot site
        </p>
        <h1 className="mt-2 font-heading text-3xl font-semibold tracking-tight">
          Enter your reader grant
        </h1>
        <p className="mt-3 leading-7 text-muted-foreground">
          The site owner issued this grant. Knot exchanges it for a revocable
          reader session and never stores the cleartext grant.
        </p>
        <ReaderAccessForm next={safeReaderReturnPath(next, siteSlug)} />
      </section>
    </main>
  );
}
