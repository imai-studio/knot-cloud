"use client";

import { Globe2, LoaderCircle, Plus } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
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
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string>();

  async function loadSites() {
    setLoading(true);
    const response = await fetch("/api/v1/session/sites", {
      cache: "no-store",
    });
    if (!response.ok) {
      setMessage("Sites could not be loaded.");
      setLoading(false);
      return;
    }
    const nextSites = (await response.json()) as Site[];
    setSites(nextSites);
    setSelectedSiteId((current) => current ?? nextSites[0]?.id);
    setLoading(false);
  }

  async function loadPublications(siteId: string) {
    setLoading(true);
    const response = await fetch(
      `/api/v1/session/sites/${siteId}/publications`,
      { cache: "no-store" },
    );
    if (response.ok) setPublications((await response.json()) as Publication[]);
    else setMessage("Publications could not be loaded.");
    setLoading(false);
  }

  async function selectSite(siteId: string) {
    setSelectedSiteId(siteId);
    await loadPublications(siteId);
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
    type: "publication.disable" | "publication.unpublish",
  ) {
    const response = await fetch(
      `/api/v1/session/publications/${publicationId}/control`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      },
    );
    if (!response.ok) {
      setMessage("The publication state could not be changed.");
      return;
    }
    if (selectedSiteId) await loadPublications(selectedSiteId);
    setMessage(
      type === "publication.unpublish"
        ? "Unpublished. Private bytes are queued for deletion."
        : "Publication disabled.",
    );
  }

  return (
    <div className="max-w-4xl">
      <Badge variant="outline" className="mb-3 rounded-full">
        Publication preview
      </Badge>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        Sites
      </h1>
      <p className="mt-2 max-w-2xl leading-7 text-muted-foreground">
        Group publications under a stable site. Reader delivery stays disabled
        until a separate content domain passes the release gate.
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
            {loading ? (
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

        <section className="border-l pl-6">
          <h2 className="text-sm font-medium">Publications</h2>
          <div className="mt-3 divide-y border-y">
            {loading ? (
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
                      <div className="flex gap-2">
                        {!publication.disabledAt ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              void control(
                                publication.id,
                                "publication.disable",
                              )
                            }
                          >
                            Disable
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={() =>
                            void control(
                              publication.id,
                              "publication.unpublish",
                            )
                          }
                        >
                          Unpublish
                        </Button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
