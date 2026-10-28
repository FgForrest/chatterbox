import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import type { StoredSummary } from "./read-summary";

/** Public provenance contains the edit attribution but no remark text or reader-visible count. */
export async function summaryCorrectionMetadata(
    stored: StoredSummary,
    ownerView: boolean,
) {
    const [editor] = stored.editedByUserId
        ? await db
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, stored.editedByUserId))
              .limit(1)
        : [];
    return {
        summaryId: stored.id,
        speakerNumberOffset: stored.speakerNumberOffset,
        editedAt: stored.editedAt?.toISOString() ?? null,
        editedByName: editor?.name ?? null,
        revision: stored.revision ?? 0,
        correctedWithRemarks: stored.remarksAppliedCount > 0,
        ...(ownerView
            ? { remarksAppliedCount: stored.remarksAppliedCount ?? 0 }
            : {}),
    };
}
