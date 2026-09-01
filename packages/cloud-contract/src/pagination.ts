import { z } from "zod";

export const pageCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{16,512}$/u);

export const pageRequestSchema = z
  .object({
    cursor: pageCursorSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const pageInfoSchema = z
  .object({
    nextCursor: pageCursorSchema.optional(),
    hasMore: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.hasMore !== (value.nextCursor !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "nextCursor must be present exactly when hasMore is true",
      });
    }
  });

export function paginatedResponseSchema<Item extends z.ZodType>(
  itemSchema: Item,
) {
  return z
    .object({
      items: z.array(itemSchema).max(100),
      page: pageInfoSchema,
    })
    .strict();
}

export type PageRequest = z.infer<typeof pageRequestSchema>;
export type PageInfo = z.infer<typeof pageInfoSchema>;
