"use client";

import { FileText, LoaderCircle, Search } from "lucide-react";
import { useState } from "react";

import type { AuditPrincipalKind } from "@/lib/audit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface SerializedAuditEvent {
  id: string;
  principalKind: AuditPrincipalKind;
  principalId: string | null;
  action: string;
  targetKind: string;
  targetId: string | null;
  outcome: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SerializedAuditPage {
  events: SerializedAuditEvent[];
  nextCursor: string | null;
}

export function AuditLogPanel({
  initialPage,
}: {
  initialPage: SerializedAuditPage;
}) {
  const [events, setEvents] = useState(initialPage.events);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [principalKind, setPrincipalKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function load(options: { append: boolean; cursor?: string }) {
    setBusy(true);
    setError(undefined);
    const search = new URLSearchParams({ limit: "25" });
    if (action.trim()) search.set("action", action.trim());
    if (outcome) search.set("outcome", outcome);
    if (principalKind) search.set("principalKind", principalKind);
    if (options.cursor) search.set("cursor", options.cursor);
    try {
      const response = await fetch(`/api/v1/session/audit-events?${search}`, {
        cache: "no-store",
      });
      const body = (await response.json()) as SerializedAuditPage & {
        title?: string;
      };
      if (!response.ok)
        throw new Error(body.title ?? "Unable to load activity.");
      setEvents((current) =>
        options.append ? [...current, ...body.events] : body.events,
      );
      setNextCursor(body.nextCursor);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load activity.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-5xl">
      <div className="flex items-start gap-3">
        <FileText className="mt-1 size-5 text-primary" aria-hidden="true" />
        <div>
          <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
            Audit log
          </h1>
          <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
            Review security-sensitive workspace actions. Knot omits secrets and
            exposes only bounded operational metadata.
          </p>
        </div>
      </div>

      <form
        className="mt-8 grid gap-4 border-y py-5 sm:grid-cols-[1fr_12rem_14rem_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void load({ append: false });
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="audit-action">Action</Label>
          <Input
            id="audit-action"
            value={action}
            placeholder="connector.rename"
            onChange={(event) => setAction(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-outcome">Outcome</Label>
          <select
            id="audit-outcome"
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
          >
            <option value="">All outcomes</option>
            <option value="accepted">Accepted</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="denied">Denied</option>
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="audit-principal">Credential</Label>
          <select
            id="audit-principal"
            className="h-10 w-full rounded-lg border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            value={principalKind}
            onChange={(event) => setPrincipalKind(event.target.value)}
          >
            <option value="">All credentials</option>
            <option value="human-session">Human session</option>
            <option value="connector-key">Connector key</option>
            <option value="consumer-api-key">API key</option>
            <option value="first-party-service">Knot service</option>
          </select>
        </div>
        <Button className="h-10" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="animate-spin" /> : <Search />}
          Apply filters
        </Button>
      </form>

      {error ? (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      <section className="mt-7" aria-label="Workspace audit events">
        {events.length === 0 ? (
          <div className="border-y py-8">
            <h2 className="font-medium">No matching activity</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Change the filters or return after a connector, publication, or
              API key action occurs.
            </p>
          </div>
        ) : (
          <ol className="divide-y border-y">
            {events.map((event) => (
              <li
                key={event.id}
                className="grid gap-2 py-5 sm:grid-cols-[10rem_1fr_auto] sm:gap-5"
              >
                <time
                  className="text-sm text-muted-foreground"
                  dateTime={event.createdAt}
                >
                  {formatDate(event.createdAt)}
                </time>
                <div className="min-w-0">
                  <p className="font-medium">{humanizeAction(event.action)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {principalLabel(event.principalKind)} · {event.targetKind}
                    {event.targetId ? ` · ${shortId(event.targetId)}` : ""}
                  </p>
                  {Object.keys(event.metadata).length > 0 ? (
                    <p className="mt-2 break-words font-mono text-xs text-muted-foreground">
                      {formatMetadata(event.metadata)}
                    </p>
                  ) : null}
                </div>
                <span className="h-fit rounded-full border px-2.5 py-1 text-xs font-medium">
                  {event.outcome}
                </span>
              </li>
            ))}
          </ol>
        )}
        {nextCursor ? (
          <Button
            className="mt-5"
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void load({ append: true, cursor: nextCursor })}
          >
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            Load older activity
          </Button>
        ) : null}
      </section>
    </div>
  );
}

function humanizeAction(value: string) {
  return value.replaceAll(".", " › ").replaceAll("-", " ");
}

function principalLabel(value: AuditPrincipalKind) {
  return {
    "human-session": "Human session",
    "connector-key": "Connector key",
    "consumer-api-key": "API key",
    "first-party-service": "Knot service",
  }[value];
}

function shortId(value: string) {
  return `${value.slice(0, 8)}…`;
}

function formatMetadata(value: Record<string, unknown>) {
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${key}: ${Array.isArray(item) ? item.join(", ") : String(item)}`,
    )
    .join(" · ");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
