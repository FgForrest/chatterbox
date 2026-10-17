import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { chatterItems } from "@/db/schema";
import type { RecordingView } from "@/lib/sharing/view";
import {
    AssignedProfileUnavailableError,
    type ResolvedItemProfile,
    resolveDefaultProfile,
    resolveItemProfile,
} from "./resolve";

/** Resolve a manual run, falling back to the owner's live default if needed. */
export async function resolveManualItemProfile(
    itemId: string,
    view: RecordingView,
    ownerUserId: string,
    actorUserId = ownerUserId,
): Promise<ResolvedItemProfile> {
    try {
        return await resolveItemProfile(itemId, view, ownerUserId, actorUserId);
    } catch (error) {
        if (!(error instanceof AssignedProfileUnavailableError)) throw error;
        const [item] = await db
            .select({ kind: chatterItems.kind })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, itemId),
                    eq(chatterItems.userId, ownerUserId),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .limit(1);
        if (!item) throw error;
        const fallback = await resolveDefaultProfile(
            ownerUserId,
            item.kind,
            actorUserId,
        );
        return { ...fallback, assigned: false };
    }
}
