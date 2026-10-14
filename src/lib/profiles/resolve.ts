import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    itemProcessing,
    processingProfileRevisions,
    processingProfiles,
} from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { getOrgUserId } from "@/lib/org/config";
import { mayUseProfile } from "@/lib/profiles/access";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    type ProfileChannel,
    type ProfileSettings,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import type { ProfileRecord } from "@/lib/profiles/store";
import type { RecordingView } from "@/lib/sharing/view";

type StoredProfile = typeof processingProfiles.$inferSelect;

/** The Organization view cannot run until a curator selects a usable profile. */
export class ProfileSelectionRequiredError extends AppError {
    constructor() {
        super(
            ErrorCode.CONFLICT,
            "Waiting for a curator to choose a profile",
            409,
        );
        this.name = "ProfileSelectionRequiredError";
    }
}

/** One immutable profile revision selected for a processing run. */
export interface ResolvedItemProfile {
    profile: ProfileRecord;
    revisionId: string;
    settings: ProfileSettings;
}

function present(
    profile: StoredProfile,
    encryptedSettings: string,
): ResolvedItemProfile {
    const settings = parseProfileSettings(
        profile.channel,
        JSON.parse(decryptText(encryptedSettings)),
    );
    return {
        profile: {
            ...profile,
            name: decryptText(profile.name),
            description: decryptText(profile.description) ?? null,
            settings,
        },
        revisionId: profile.currentRevisionId ?? "",
        settings,
    };
}

async function readProfileRevision(input: {
    profileId: string;
    ownerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
    revisionId?: string;
    scope?: "personal" | "organization";
    allowArchived?: boolean;
}): Promise<ResolvedItemProfile | null> {
    const [row] = await db
        .select({
            profile: processingProfiles,
            revisionId: processingProfileRevisions.id,
            settings: processingProfileRevisions.settings,
        })
        .from(processingProfiles)
        .innerJoin(
            processingProfileRevisions,
            and(
                eq(
                    processingProfileRevisions.id,
                    input.revisionId ?? processingProfiles.currentRevisionId,
                ),
                eq(processingProfileRevisions.profileId, processingProfiles.id),
            ),
        )
        .where(
            and(
                eq(processingProfiles.id, input.profileId),
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.channel, input.channel),
                input.scope
                    ? eq(processingProfiles.scope, input.scope)
                    : undefined,
                input.allowArchived
                    ? undefined
                    : isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    if (!row || !(await mayUseProfile(input.actorUserId, row.profile))) {
        return null;
    }
    const resolved = present(row.profile, row.settings);
    return { ...resolved, revisionId: row.revisionId };
}

async function defaultProfile(input: {
    ownerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
    scope: "personal" | "organization";
}): Promise<ResolvedItemProfile | null> {
    await ensureProfiles(input.ownerUserId);
    const [profile] = await db
        .select({ id: processingProfiles.id })
        .from(processingProfiles)
        .where(
            and(
                eq(processingProfiles.ownerUserId, input.ownerUserId),
                eq(processingProfiles.channel, input.channel),
                eq(processingProfiles.scope, input.scope),
                eq(processingProfiles.isDefault, true),
                isNull(processingProfiles.archivedAt),
            ),
        )
        .limit(1);
    return profile
        ? readProfileRevision({ ...input, profileId: profile.id })
        : null;
}

/**
 * Resolve the immutable profile revision used by one item run.
 *
 * `ownerUserId` scopes every item and processing-state read. Callers already
 * know it from their authorized run context.
 */
export async function resolveItemProfile(
    itemId: string,
    view: RecordingView,
    ownerUserId: string,
    actorUserId = ownerUserId,
): Promise<ResolvedItemProfile> {
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
    if (!item) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Item not found",
            404,
        );
    }
    const channel = item.kind;
    const [processing] = await db
        .select({ profileId: itemProcessing.profileId })
        .from(itemProcessing)
        .where(
            and(
                eq(itemProcessing.itemId, itemId),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, view),
            ),
        )
        .limit(1);
    const orgUserId = await getOrgUserId();

    if (processing?.profileId) {
        if (view === "private") {
            const personal = await readProfileRevision({
                profileId: processing.profileId,
                ownerUserId,
                actorUserId,
                channel,
                scope: "personal",
            });
            if (personal) return personal;
            if (orgUserId) {
                const organization = await readProfileRevision({
                    profileId: processing.profileId,
                    ownerUserId: orgUserId,
                    actorUserId,
                    channel,
                    scope: "organization",
                });
                if (organization) return organization;
            }
        } else if (orgUserId) {
            const organization = await readProfileRevision({
                profileId: processing.profileId,
                ownerUserId: orgUserId,
                actorUserId,
                channel,
                scope: "organization",
            });
            if (organization) return organization;
        }
    }

    if (view === "private") {
        const resolved = await defaultProfile({
            ownerUserId,
            actorUserId,
            channel,
            scope: "personal",
        });
        if (resolved) return resolved;
        throw new AppError(
            ErrorCode.CONFLICT,
            "Choose a processing profile before running this step",
            409,
        );
    }

    if (orgUserId) {
        const resolved = await defaultProfile({
            ownerUserId: orgUserId,
            actorUserId,
            channel,
            scope: "organization",
        });
        if (resolved) return resolved;
    }
    throw new ProfileSelectionRequiredError();
}

/** Read the exact immutable revision already recorded for a run. */
export async function loadItemProfileRevision(input: {
    itemId: string;
    view: RecordingView;
    ownerUserId: string;
    actorUserId?: string;
    revisionId: string;
}): Promise<ResolvedItemProfile> {
    const [item] = await db
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, input.itemId),
                eq(chatterItems.userId, input.ownerUserId),
            ),
        )
        .limit(1);
    if (!item) {
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Item not found",
            404,
        );
    }
    const orgUserId = await getOrgUserId();
    const actorUserId = input.actorUserId ?? input.ownerUserId;
    const candidates =
        input.view === "org"
            ? orgUserId
                ? [{ ownerUserId: orgUserId, scope: "organization" as const }]
                : []
            : [
                  {
                      ownerUserId: input.ownerUserId,
                      scope: "personal" as const,
                  },
                  ...(orgUserId
                      ? [
                            {
                                ownerUserId: orgUserId,
                                scope: "organization" as const,
                            },
                        ]
                      : []),
              ];
    let resolved: ResolvedItemProfile | null = null;
    for (const candidate of candidates) {
        const [revision] = await db
            .select({ profileId: processingProfileRevisions.profileId })
            .from(processingProfileRevisions)
            .innerJoin(
                processingProfiles,
                and(
                    eq(
                        processingProfiles.id,
                        processingProfileRevisions.profileId,
                    ),
                    eq(processingProfiles.ownerUserId, candidate.ownerUserId),
                ),
            )
            .where(eq(processingProfileRevisions.id, input.revisionId))
            .limit(1);
        if (!revision) continue;
        resolved = await readProfileRevision({
            profileId: revision.profileId,
            ownerUserId: candidate.ownerUserId,
            actorUserId,
            channel: item.kind,
            revisionId: input.revisionId,
            scope: candidate.scope,
            allowArchived: true,
        });
        if (resolved) break;
    }
    if (!resolved) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "The processing profile revision used by this run is unavailable",
            404,
        );
    }
    return resolved;
}
