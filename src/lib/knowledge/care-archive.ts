import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { almanacDuplicateDismissals } from "@/db/schema";
import { decryptJsonField } from "@/lib/encryption/fields";
import type { ArchiveScope } from "@/lib/export/archive-scope";

/** Maximum UTF-8 restore request size, including an independently retryable archive chunk and ID map. */
export const CARE_RESTORE_MAX_BYTES = 32 * 1024 * 1024;

const content = z.object({
    kind: z.enum(["fact_conflict", "correction_conflict", "thin"]),
    records: z
        .array(
            z.object({
                id: z.string().min(1).max(64),
                kind: z.enum(["person", "entity"]),
                name: z.string().max(200),
            }),
        )
        .max(2000),
    relationKey: z.string().max(64).nullable(),
    heard: z.string().max(200).nullable(),
    values: z.array(z.string().max(500)).max(2000),
    lastAt: z.string().datetime().nullable(),
});
export const careArchiveSchema = z.object({
    version: z.literal(1),
    provenance: z.literal("not-included"),
    duplicates: z
        .array(
            z.object({
                kind: z.enum(["person", "entity"]),
                left: z.string().min(1).max(64),
                right: z.string().min(1).max(64),
            }),
        )
        .max(100000),
    problems: z.array(content).max(100000),
});
export type CareArchive = z.infer<typeof careArchiveSchema>;

/** Organization decisions are portable; share undo fingerprints are deliberately not archived. */
export async function collectCareArchive(
    scope: ArchiveScope,
): Promise<CareArchive | null> {
    if (scope.kind !== "organization") return null;
    const rows = await db
        .select()
        .from(almanacDuplicateDismissals)
        .where(eq(almanacDuplicateDismissals.userId, scope.orgUserId));
    return {
        version: 1,
        provenance: "not-included",
        duplicates: rows.flatMap((row): CareArchive["duplicates"] =>
            row.kind === "person" && row.leftPersonId && row.rightPersonId
                ? [
                      {
                          kind: "person" as const,
                          left: row.leftPersonId,
                          right: row.rightPersonId,
                      },
                  ]
                : row.kind === "entity" && row.leftEntityId && row.rightEntityId
                  ? [
                        {
                            kind: "entity" as const,
                            left: row.leftEntityId,
                            right: row.rightEntityId,
                        },
                    ]
                  : [],
        ),
        problems: rows.flatMap((row) => {
            if (!row.problemData) return [];
            const parsed = content.safeParse(decryptJsonField(row.problemData));
            return parsed.success ? [parsed.data] : [];
        }),
    };
}
