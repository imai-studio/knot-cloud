import { z } from "zod";

import { idempotencyKeySchema, sha256Schema } from "./identifiers.js";
import { protocolVersion } from "./protocol.js";

const resourceIdSchema = z.uuid();
const publicationSlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9/_-]{0,198}[a-z0-9])?$/u)
  .refine(
    (value) => !value.includes("//"),
    "Slug cannot contain consecutive slashes",
  )
  .refine(
    (value) =>
      !["api", "_next", "www", "admin", "health", "assets"].includes(
        value.split("/")[0]!,
      ),
    "Slug uses a reserved prefix",
  );

export const publicationSourceProvenanceSchema = z
  .object({
    sourceType: z.enum([
      "anytype-object",
      "anytype-collection",
      "anytype-chat",
      "other",
    ]),
    sourceDigest: sha256Schema,
    sourcePointer: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{1,512}$/u)
      .optional(),
  })
  .strict();

const textMarkSchema = z.enum([
  "bold",
  "code",
  "italic",
  "strikethrough",
  "underline",
]);

const textSpanSchema = z.object({
  text: z.string().max(10_000),
  marks: z.array(textMarkSchema).max(5).default([]),
  href: z
    .url()
    .refine(
      (value) =>
        ["http:", "https:", "mailto:"].includes(new URL(value).protocol),
      {
        message: "Links must use http, https, or mailto",
      },
    )
    .optional(),
});

const textContentSchema = z.array(textSpanSchema).max(1_000);

const headingBlockSchema = z.object({
  type: z.literal("heading"),
  level: z.number().int().min(1).max(6),
  content: textContentSchema,
});

const paragraphBlockSchema = z.object({
  type: z.literal("paragraph"),
  content: textContentSchema,
});

const quoteBlockSchema = z.object({
  type: z.literal("quote"),
  content: textContentSchema,
});

const codeBlockSchema = z.object({
  type: z.literal("code"),
  language: z
    .string()
    .trim()
    .regex(/^[a-z0-9+#.-]{1,30}$/u)
    .optional(),
  code: z.string().max(250_000),
});

const listBlockSchema = z.object({
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(textContentSchema).max(1_000),
});

const assetBlockSchema = z.object({
  type: z.enum(["file", "image"]),
  assetDigest: sha256Schema,
  alt: z.string().max(2_000).optional(),
  caption: textContentSchema.optional(),
});

const tableBlockSchema = z.object({
  type: z.literal("table"),
  rows: z.array(z.array(textContentSchema).max(100)).max(1_000),
});

export const publicationBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  quoteBlockSchema,
  codeBlockSchema,
  listBlockSchema,
  assetBlockSchema,
  tableBlockSchema,
]);

export const publicationDocumentSchema = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(5_000).optional(),
  blocks: z.array(publicationBlockSchema).max(10_000),
});

export const publicationMutationSchema = z
  .object({
    connectorId: resourceIdSchema,
    siteId: resourceIdSchema,
    publicationId: resourceIdSchema,
    slug: publicationSlugSchema,
    operation: z.enum(["create", "update"]),
    document: publicationDocumentSchema,
    contentSha256: sha256Schema,
    assetDigests: z.array(sha256Schema).max(1_000),
    sourceProvenance: publicationSourceProvenanceSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((value, context) => {
    const declared = new Set(value.assetDigests);
    if (declared.size !== value.assetDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["assetDigests"],
        message: "Asset digests must be unique",
      });
    }
    for (const [index, block] of value.document.blocks.entries()) {
      if (
        (block.type === "file" || block.type === "image") &&
        !declared.has(block.assetDigest)
      ) {
        context.addIssue({
          code: "custom",
          path: ["document", "blocks", index, "assetDigest"],
          message: "Every document asset must be declared in assetDigests",
        });
      }
    }
  });

export const publicationCreatedSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    publicationId: resourceIdSchema,
    versionId: resourceIdSchema,
    state: z.literal("ready"),
  })
  .strict();

export const publicationControlOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("publication.disable"),
    publicationId: resourceIdSchema,
  }),
  z.object({
    type: z.literal("publication.rollback"),
    publicationId: resourceIdSchema,
    versionId: resourceIdSchema,
  }),
  z.object({
    type: z.literal("publication.unpublish"),
    publicationId: resourceIdSchema,
  }),
]);

export const connectorPublicationStatusRequestSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorId: resourceIdSchema,
    publicationId: resourceIdSchema,
  })
  .strict();

export const connectorPublicationStatusSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    publicationId: resourceIdSchema,
    siteId: resourceIdSchema,
    slug: publicationSlugSchema,
    state: z.enum(["draft", "ready", "disabled", "unpublished"]),
    currentVersionId: resourceIdSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export const connectorPublicationControlRequestSchema = z
  .object({
    protocolVersion: z.literal(protocolVersion),
    connectorId: resourceIdSchema,
    idempotencyKey: idempotencyKeySchema,
    operation: publicationControlOperationSchema,
  })
  .strict();

export const publicationControlResultSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("publication.disable"),
      publicationId: resourceIdSchema,
      disabledAt: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("publication.rollback"),
      publicationId: resourceIdSchema,
      currentVersionId: resourceIdSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("publication.unpublish"),
      publicationId: resourceIdSchema,
      unpublishedAt: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type PublicationDocument = z.infer<typeof publicationDocumentSchema>;
export type PublicationMutation = z.infer<typeof publicationMutationSchema>;
export type PublicationControlResult = z.infer<
  typeof publicationControlResultSchema
>;
