import { and, eq, isNull, or } from "drizzle-orm";
import { chatterItems, processingProfiles, recordings } from "@/db/schema";
import {
    sharedItemCondition,
    sharedRecordingCondition,
} from "@/lib/sharing/shared";

/**
 * Whose content a backup or an export carries: one person's own, or the
 * Organization's, including that account's own content. Never chosen by the request: the account
 * asking decides it.
 */
export type ArchiveScope =
    | { kind: "personal"; userId: string }
    | { kind: "organization"; orgUserId: string };

/** The account a scope's own knowledge rows (`userId`) belong to. */
export function scopeUserId(scope: ArchiveScope): string {
    return scope.kind === "personal" ? scope.userId : scope.orgUserId;
}

/**
 * SQL predicate on `recordings`: the live recordings a scope carries. A
 * person's own, shared ones included; for the Organization, every shared
 * one and every recording owned by the Organization account.
 */
export function archivedRecordingCondition(scope: ArchiveScope) {
    return and(
        scope.kind === "personal"
            ? eq(recordings.userId, scope.userId)
            : or(
                  eq(recordings.userId, scope.orgUserId),
                  sharedRecordingCondition(scope.orgUserId),
              ),
        isNull(recordings.deletedAt),
    );
}

/** `archivedRecordingCondition` on `chatter_items`: items of every kind. */
export function archivedItemCondition(scope: ArchiveScope) {
    return and(
        scope.kind === "personal"
            ? eq(chatterItems.userId, scope.userId)
            : or(
                  eq(chatterItems.userId, scope.orgUserId),
                  sharedItemCondition(scope.orgUserId),
              ),
        isNull(chatterItems.deletedAt),
    );
}

/** SQL predicate on `processing_profiles`: profiles owned by this scope. */
export function archivedProfileCondition(scope: ArchiveScope) {
    return and(
        eq(processingProfiles.ownerUserId, scopeUserId(scope)),
        eq(
            processingProfiles.scope,
            scope.kind === "personal" ? "personal" : "organization",
        ),
    );
}
