"use client";

import { ChevronDown, Globe2, History, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type Site = {
  id: string;
  name: string;
  slug: string;
  createdAt: Date | string;
};

export type Publication = {
  id: string;
  slug: string;
  currentVersionId?: string;
  disabledAt?: Date | string;
  unpublishedAt?: Date | string;
  updatedAt: Date | string;
};

type PublicationVersion = {
  id: string;
  state: "draft" | "ready" | "disabled" | "unpublished" | "abandoned";
  schemaVersion: string;
  contentSha256: string;
  connectorId: string;
  createdAt: string;
  committedAt?: string;
};

export function SitesPanel({
  initialPublications,
  initialSites,
}: {
  initialPublications: Publication[];
  initialSites: Site[];
}) {
  const [sites, setSites] = useState(initialSites);
  const [selectedSiteId, setSelectedSiteId] = useState<string | undefined>(
    initialSites[0]?.id,
  );
  const [publications, setPublications] = useState(initialPublications);
  const [loadingSites, setLoadingSites] = useState(false);
  const [loadingPublications, setLoadingPublications] = useState(false);
  const [loadingVersionId, setLoadingVersionId] = useState<string>();
  const [expandedPublicationId, setExpandedPublicationId] = useState<string>();
  const [versions, setVersions] = useState<
    Record<string, PublicationVersion[]>
  >({});
  const [message, setMessage] = useState<string>();

  async function loadSites() {
    setLoadingSites(true);
    const response = await fetch("/api/v1/session/sites", {
      cache: "no-store",
    });
    if (!response.ok) {
      setMessage("Sites could not be loaded.");
      setLoadingSites(false);
      return;
    }
    const nextSites = (await response.json()) as Site[];
    setSites(nextSites);
    setSelectedSiteId((current) => current ?? nextSites[0]?.id);
    setLoadingSites(false);
  }

  async function loadPublications(siteId: string) {
    setLoadingPublications(true);
    const response = await fetch(
      `/api/v1/session/sites/${siteId}/publications`,
      { cache: "no-store" },
    );
    if (response.ok) setPublications((await response.json()) as Publication[]);
    else setMessage("Publications could not be loaded.");
    setLoadingPublications(false);
  }

  async function selectSite(siteId: string) {
    setSelectedSiteId(siteId);
    setExpandedPublicationId(undefined);
    await loadPublications(siteId);
  }

  async function toggleVersions(publicationId: string) {
    if (expandedPublicationId === publicationId) {
      setExpandedPublicationId(undefined);
      return;
    }
    setExpandedPublicationId(publicationId);
    if (versions[publicationId]) return;
    setLoadingVersionId(publicationId);
    const response = await fetch(
      `/api/v1/session/publications/${publicationId}/versions`,
      { cache: "no-store" },
    );
    if (response.ok) {
      const loaded = (await response.json()) as PublicationVersion[];
      setVersions((current) => ({
        ...current,
        [publicationId]: loaded,
      }));
    } else {
      setMessage("Version history could not be loaded. Try again.");
    }
    setLoadingVersionId(undefined);
  }

  async function createSite(formData: FormData) {
    setMessage(undefined);
    const response = await fetch("/api/v1/session/sites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        slug: formData.get("slug"),
      }),
    });
    if (!response.ok) {
      setMessage("Choose a valid, unused name and slug.");
      return;
    }
    const site = (await response.json()) as Site;
    await loadSites();
    setSelectedSiteId(site.id);
    setPublications([]);
    setMessage("Site created. Pair a connector before publishing.");
  }

  async function control(
    publicationId: string,
    operation:
      | { type: "publication.disable" }
      | { type: "publication.unpublish" }
      | { type: "publication.rollback"; versionId: string },
  ) {
    if (
      operation.type === "publication.unpublish" &&
      !window.confirm(
        "Unpublish this item? It will stop serving immediately and its stored content will be deleted.",
      )
    ) {
      return;
    }
    const response = await fetch(
      `/api/v1/session/publications/${publicationId}/control`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(operation),
      },
    );
    if (!response.ok) {
      setMessage("The publication state could not be changed.");
      return;
    }
    if (selectedSiteId) await loadPublications(selectedSiteId);
    setMessage(
      operation.type === "publication.unpublish"
        ? "Unpublished. Private bytes are queued for deletion."
        : operation.type === "publication.rollback"
          ? "Publication now uses the selected ready version."
          : "Publication disabled.",
    );
  }

  return (
    <div className="max-w-4xl">
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Sites
      </h1>
      <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
        Group publications under a stable site, inspect their versions, and
        control what remains available.
      </p>

      <form
        action={createSite}
        className="mt-8 grid gap-4 border-y py-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="space-y-2">
          <Label htmlFor="site-name">Site name</Label>
          <Input
            id="site-name"
            name="name"
            placeholder="Research notes"
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="site-slug">Private slug</Label>
          <Input
            id="site-slug"
            name="slug"
            placeholder="research-notes"
            pattern="[a-z0-9][a-z0-9-]{0,62}"
            required
          />
        </div>
        <Button type="submit" className="h-10">
          <Plus className="size-4" />
          Create site
        </Button>
      </form>

      {message ? (
        <p role="status" className="mt-4 text-sm text-muted-foreground">
          {message}
        </p>
      ) : null}

      <div className="mt-8 grid gap-6 sm:grid-cols-[14rem_1fr]">
        <section>
          <h2 className="text-sm font-medium">Your sites</h2>
          <div className="mt-3 space-y-1">
            {loadingSites ? (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            ) : sites.length === 0 ? (
              <p className="text-sm leading-6 text-muted-foreground">
                No sites yet. Create one to receive connector publications.
              </p>
            ) : (
              sites.map((site) => (
                <button
                  key={site.id}
                  type="button"
                  onClick={() => void selectSite(site.id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${
                    selectedSiteId === site.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted"
                  }`}
                >
                  <Globe2 className="size-4" />
                  <span className="min-w-0 truncate">{site.name}</span>
                </button>
              ))
            )}
          </div>
        </section>

        <section className="border-t pt-6 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <h2 className="text-sm font-medium">Publications</h2>
          <div className="mt-3 divide-y border-y">
            {loadingPublications ? (
              <div className="py-5">
                <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : publications.length === 0 ? (
              <p className="py-5 text-sm text-muted-foreground">
                No connector has committed a publication to this site.
              </p>
            ) : (
              publications.map((publication) => (
                <div key={publication.id} className="py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">/{publication.slug}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {publication.unpublishedAt
                          ? "Deletion pending"
                          : publication.disabledAt
                            ? "Disabled"
                            : "Ready privately"}
                      </p>
                    </div>
                    {!publication.unpublishedAt ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-expanded={
                            expandedPublicationId === publication.id
                          }
                          onClick={() => void toggleVersions(publication.id)}
                        >
                          <History />
                          Versions
                          <ChevronDown
                            className={
                              expandedPublicationId === publication.id
                                ? "rotate-180"
                                : undefined
                            }
                          />
                        </Button>
                        {!publication.disabledAt ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void control(publication.id, {
                                type: "publication.disable",
                              })
                            }
                          >
                            Disable
                          </Button>
                        ) : publication.currentVersionId ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void control(publication.id, {
                                type: "publication.rollback",
                                versionId: publication.currentVersionId!,
                              })
                            }
                          >
                            Enable
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            void control(publication.id, {
                              type: "publication.unpublish",
                            })
                          }
                        >
                          Unpublish
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {expandedPublicationId === publication.id ? (
                    <div className="mt-4 border-l pl-4">
                      <h3 className="text-sm font-medium">Version history</h3>
                      {loadingVersionId === publication.id &&
                      !versions[publication.id] ? (
                        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                          <LoaderCircle className="size-4 animate-spin" />{" "}
                          Loading versions
                        </p>
                      ) : (versions[publication.id]?.length ?? 0) === 0 ? (
                        <p className="mt-2 text-sm text-muted-foreground">
                          No version history is available.
                        </p>
                      ) : (
                        <ol className="mt-2 divide-y">
                          {versions[publication.id]?.map((version) => {
                            const current =
                              version.id === publication.currentVersionId;
                            return (
                              <li
                                key={version.id}
                                className="flex flex-wrap items-center justify-between gap-3 py-3"
                              >
                                <div>
                                  <p className="text-sm font-medium">
                                    {current
                                      ? "Current version"
                                      : `Version ${shortId(version.id)}`}
                                  </p>
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    {formatDate(
                                      version.committedAt ?? version.createdAt,
                                    )}{" "}
                                    · {version.state}
                                  </p>
                                </div>
                                {!current &&
                                version.state === "ready" &&
                                !publication.unpublishedAt ? (
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      void control(publication.id, {
                                        type: "publication.rollback",
                                        versionId: version.id,
                                      })
                                    }
                                  >
                                    Roll back to this version
                                  </Button>
                                ) : null}
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function shortId(value: string) {
  return `${value.slice(0, 8)}…`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
