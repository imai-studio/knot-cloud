import {
  publicationDocumentSchema,
  type PublicationDocument,
} from "@imai/knot-cloud-contract";

import type { ObjectLocator, StoredObject } from "@/lib/ports";

export interface PublicPageRecord {
  tenantId: string;
  siteId: string;
  publicationId: string;
  versionId: string;
  document: PublicationDocument;
  contentSha256: string;
  updatedAt: Date;
}

export interface PublicAssetRecord extends ObjectLocator {
  publicationId: string;
  versionId: string;
  contentType: string;
  byteSize: number;
}

export interface PublicReaderRepository {
  resolveCustomDomainSite?(
    hostname: string,
  ): Promise<
    { siteSlug: string; readerAccess: "public" | "authenticated" } | undefined
  >;
  resolveSiteAccess?(
    siteSlug: string,
  ): Promise<"public" | "authenticated" | undefined>;
  resolvePage(input: {
    siteSlug: string;
    publicationSlug: string;
    sessionDigest?: string;
  }): Promise<PublicPageRecord | undefined>;
  resolveAsset(input: {
    siteSlug: string;
    publicationId: string;
    sha256: string;
    sessionDigest?: string;
  }): Promise<PublicAssetRecord | undefined>;
}

export interface PublicAssetStore {
  get(locator: ObjectLocator): Promise<StoredObject | undefined>;
}

export function parsePublicPageRecord(input: {
  tenantId: string;
  siteId: string;
  publicationId: string;
  versionId: string;
  document: unknown;
  contentSha256: string;
  updatedAt: Date;
}): PublicPageRecord {
  return {
    ...input,
    document: publicationDocumentSchema.parse(input.document),
  };
}
