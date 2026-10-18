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
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { mayUseProfile } from "@/lib/profiles/access";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    type ProfileChannel,
    type ProfileSettings,
    parseProfileSettings,
} from "@/lib/profiles/settings";
import {
    getDefaultProfile,
    getProfile,
    type ProfileRecord,
} from "@/lib/profiles/store";
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

/** The immutable profile assigned to an item can no longer be used. */
export class AssignedProfileUnavailableError extends AppError {
    constructor() {
        super(
            ErrorCode.CONFLICT,
            "The processing profile assigned to this item is unavailable",
            409,
        );
        this.name = "AssignedProfileUnavailableError";
    }
}

/** One immutable profile revision selected for a processing run. */
export interface ResolvedItemProfile {
    profile: ProfileRecord;
    revisionId: string;
    settings: ProfileSettings;
    /** True when this immutable revision is frozen on the item's pipeline. */
    assigned?: boolean;
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

/** Resolve a live profile selected explicitly by an actor. */
export async function resolveSelectedProfile(input: {
    profileId: string;
    actorUserId: string;
    view?: RecordingView;
}): Promise<ResolvedItemProfile | null> {
    if ((input.view ?? "private") === "private") {
        await ensureProfiles(input.actorUserId);
        const personal = await getProfile(
            input.actorUserId,
            input.profileId,
            input.actorUserId,
        );
        if (personal?.currentRevisionId) {
            return {
                profile: personal,
                revisionId: personal.currentRevisionId,
                settings: personal.settings,
            };
        }
    }

    const orgUserId = await getOrgUserId();
    if (!isOrgScopeEnabled() || !orgUserId || orgUserId === input.actorUserId) {
        return null;
    }
    await ensureProfiles(orgUserId);
    const organization = await getProfile(
        orgUserId,
        input.profileId,
        input.actorUserId,
    );
    if (!organization?.currentRevisionId) return null;
    return {
        profile: organization,
        revisionId: organization.currentRevisionId,
        settings: organization.settings,
    };
}

/** Load an explicitly selected immutable revision and recheck use access. */
export async function loadSelectedProfileRevision(input: {
    revisionId: string;
    actorUserId: string;
    channel: ProfileChannel;
    view: RecordingView;
}): Promise<ResolvedItemProfile> {
    const orgUserId = await getOrgUserId();
    const candidates =
        input.view === "org"
            ? orgUserId
                ? [
                      {
                          ownerUserId: orgUserId,
                          scope: "organization" as const,
                      },
                  ]
                : []
            : [
                  {
                      ownerUserId: input.actorUserId,
                      scope:
                          orgUserId === input.actorUserId
                              ? ("organization" as const)
                              : ("personal" as const),
                  },
                  ...(orgUserId && orgUserId !== input.actorUserId
                      ? [
                            {
                                ownerUserId: orgUserId,
                                scope: "organization" as const,
                            },
                        ]
                      : []),
              ];
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
                    eq(processingProfiles.scope, candidate.scope),
                    eq(processingProfiles.channel, input.channel),
                ),
            )
            .where(eq(processingProfileRevisions.id, input.revisionId))
            .limit(1);
        if (!revision) continue;
        const resolved = await readProfileRevision({
            profileId: revision.profileId,
            ownerUserId: candidate.ownerUserId,
            actorUserId: input.actorUserId,
            channel: input.channel,
            revisionId: input.revisionId,
            scope: candidate.scope,
            allowArchived: true,
        });
        if (resolved) return resolved;
    }
    throw new AppError(
        input.view === "org" ? ErrorCode.INVALID_INPUT : ErrorCode.NOT_FOUND,
        "The selected processing profile revision is unavailable",
        input.view === "org" ? 400 : 404,
    );
}

async function defaultProfile(input: {
    ownerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
}): Promise<ResolvedItemProfile | null> {
    const profile = await getDefaultProfile(
        input.ownerUserId,
        input.channel,
        input.actorUserId,
    );
    if (!profile) return null;
    if (!profile.currentRevisionId) return null;
    return {
        profile,
        revisionId: profile.currentRevisionId,
        settings: profile.settings,
    };
}

/** Resolve the owner's current default profile when no item exists yet. */
export async function resolveDefaultProfile(
    ownerUserId: string,
    channel: ProfileChannel,
    actorUserId = ownerUserId,
): Promise<ResolvedItemProfile> {
    const resolved = await defaultProfile({
        ownerUserId,
        actorUserId,
        channel,
    });
    if (resolved) return resolved;
    throw new AppError(
        ErrorCode.CONFLICT,
        "Choose a default processing profile before running this step",
        409,
    );
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
        .select({
            profileId: itemProcessing.profileId,
            profileRevisionId: itemProcessing.profileRevisionId,
        })
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
                ...(processing.profileRevisionId
                    ? { revisionId: processing.profileRevisionId }
                    : {}),
                allowArchived: true,
            });
            if (personal) return { ...personal, assigned: true };
            if (orgUserId) {
                const organization = await readProfileRevision({
                    profileId: processing.profileId,
                    ownerUserId: orgUserId,
                    actorUserId,
                    channel,
                    scope: "organization",
                    ...(processing.profileRevisionId
                        ? { revisionId: processing.profileRevisionId }
                        : {}),
                    allowArchived: true,
                });
                if (organization) return { ...organization, assigned: true };
            }
        } else if (orgUserId) {
            const organization = await readProfileRevision({
                profileId: processing.profileId,
                ownerUserId: orgUserId,
                actorUserId,
                channel,
                scope: "organization",
                ...(processing.profileRevisionId
                    ? { revisionId: processing.profileRevisionId }
                    : {}),
                allowArchived: true,
            });
            if (organization) return { ...organization, assigned: true };
        }
        if (view === "private") throw new AssignedProfileUnavailableError();
    }

    if (view === "private") {
        const resolved = await defaultProfile({
            ownerUserId,
            actorUserId,
            channel,
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
