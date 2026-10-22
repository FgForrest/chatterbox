import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
    folderDefaultProfiles,
    itemProcessing,
    recordingFolders,
} from "@/db/schema";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { ensureProfiles } from "@/lib/profiles/seed";
import type { ProfileChannel } from "@/lib/profiles/settings";
import {
    getDefaultProfile,
    getDefaultProfileState,
    getProfile,
    listProfiles,
    type ProfileRecord,
} from "@/lib/profiles/store";
import type { RecordingView } from "@/lib/sharing/view";

export interface FolderDefaultProfileDetails {
    own: ProfileRecord | null;
    ownManualOnly: boolean;
    effective: ProfileRecord | null;
    effectiveManualOnly: boolean;
    inheritedFromFolderId: string | null;
}

export type PlacementProfileCandidate =
    | { kind: "profile"; profile: ProfileRecord }
    | { kind: "manual_only" };

export type PlacementProfileResolution =
    | {
          status: "resolved";
          profile: ProfileRecord;
          manualOnly: boolean;
          source: "folder" | "default";
      }
    | { status: "choose"; candidates: PlacementProfileCandidate[] }
    | { status: "waiting_for_curator" };

type FolderDefaultOutcome =
    | { kind: "profile"; profile: ProfileRecord }
    | { kind: "manual_only" };

type ProfileReader = Pick<typeof db, "select">;

async function organizationUserIdOr(
    known: string | null | undefined,
): Promise<string | null> {
    return known !== undefined ? known : await getOrgUserId();
}

interface FolderContext {
    id: string;
    ownerUserId: string;
    parentId: string | null;
}

async function accessibleFolder(
    folderId: string,
    allowedOwnerUserIds: readonly string[],
    executor: ProfileReader = db,
): Promise<FolderContext | null> {
    if (allowedOwnerUserIds.length === 0) return null;
    const [folder] = await executor
        .select({
            id: recordingFolders.id,
            ownerUserId: recordingFolders.userId,
            parentId: recordingFolders.parentId,
        })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, folderId),
                inArray(recordingFolders.userId, [...allowedOwnerUserIds]),
            ),
        )
        .limit(1);
    return folder ?? null;
}

async function usableDefaultAtFolder(input: {
    folderId: string;
    folderOwnerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
    organizationUserId: string | null;
    organizationOnly: boolean;
    executor?: ProfileReader;
}): Promise<FolderDefaultOutcome | null> {
    const [row] = await (input.executor ?? db)
        .select({
            profileId: folderDefaultProfiles.profileId,
            manualOnly: folderDefaultProfiles.manualOnly,
        })
        .from(folderDefaultProfiles)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, folderDefaultProfiles.folderId),
        )
        .where(
            and(
                eq(folderDefaultProfiles.folderId, input.folderId),
                eq(folderDefaultProfiles.channel, input.channel),
                eq(recordingFolders.userId, input.folderOwnerUserId),
            ),
        )
        .limit(1);
    if (!row) return null;
    if (row.manualOnly) return { kind: "manual_only" };
    if (!row.profileId) return null;

    const owners = input.organizationOnly
        ? input.organizationUserId
            ? [input.organizationUserId]
            : []
        : [
              input.folderOwnerUserId,
              ...(input.organizationUserId &&
              input.organizationUserId !== input.folderOwnerUserId
                  ? [input.organizationUserId]
                  : []),
          ];
    for (const ownerUserId of owners) {
        const profile = await getProfile(
            ownerUserId,
            row.profileId,
            input.actorUserId,
            { executor: input.executor, readOnly: Boolean(input.executor) },
        );
        if (
            profile?.channel === input.channel &&
            (!input.organizationOnly || profile.scope === "organization")
        ) {
            return { kind: "profile", profile };
        }
    }
    return null;
}

/** Read a folder's own and nearest inherited usable default for one channel. */
export async function folderDefaultProfileDetails(input: {
    folderId: string;
    folderOwnerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
    organizationOnly?: boolean;
    executor?: ProfileReader;
    organizationUserId?: string | null;
}): Promise<FolderDefaultProfileDetails | null> {
    const organizationUserId = await organizationUserIdOr(
        input.organizationUserId,
    );
    const folder = await accessibleFolder(
        input.folderId,
        [input.folderOwnerUserId],
        input.executor,
    );
    if (!folder) return null;
    if (folder.parentId === null) {
        return {
            own: null,
            ownManualOnly: false,
            effective: null,
            effectiveManualOnly: false,
            inheritedFromFolderId: null,
        };
    }

    const own = await usableDefaultAtFolder({
        folderId: folder.id,
        folderOwnerUserId: folder.ownerUserId,
        actorUserId: input.actorUserId,
        channel: input.channel,
        organizationUserId,
        organizationOnly: input.organizationOnly ?? false,
        executor: input.executor,
    });
    if (own) {
        return {
            own: own.kind === "profile" ? own.profile : null,
            ownManualOnly: own.kind === "manual_only",
            effective: own.kind === "profile" ? own.profile : null,
            effectiveManualOnly: own.kind === "manual_only",
            inheritedFromFolderId: null,
        };
    }

    let parentId = folder.parentId;
    while (parentId) {
        const parent = await accessibleFolder(
            parentId,
            [folder.ownerUserId],
            input.executor,
        );
        if (!parent || parent.parentId === null) break;
        const inherited = await usableDefaultAtFolder({
            folderId: parent.id,
            folderOwnerUserId: folder.ownerUserId,
            actorUserId: input.actorUserId,
            channel: input.channel,
            organizationUserId,
            organizationOnly: input.organizationOnly ?? false,
            executor: input.executor,
        });
        if (inherited) {
            return {
                own: null,
                ownManualOnly: false,
                effective:
                    inherited.kind === "profile" ? inherited.profile : null,
                effectiveManualOnly: inherited.kind === "manual_only",
                inheritedFromFolderId: parent.id,
            };
        }
        parentId = parent.parentId;
    }
    return {
        own: null,
        ownManualOnly: false,
        effective: null,
        effectiveManualOnly: false,
        inheritedFromFolderId: null,
    };
}

/** Resolve one folder's usable default, inheriting to but never from its root. */
export async function folderDefaultProfile(
    folderId: string,
    channel: ProfileChannel,
): Promise<ProfileRecord | null> {
    const [folder] = await db
        .select({ ownerUserId: recordingFolders.userId })
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folderId))
        .limit(1);
    if (!folder) return null;
    const details = await folderDefaultProfileDetails({
        folderId,
        folderOwnerUserId: folder.ownerUserId,
        actorUserId: folder.ownerUserId,
        channel,
        organizationOnly: (await getOrgUserId()) === folder.ownerUserId,
    });
    return details?.effective ?? null;
}

async function usableProfiles(
    ownerUserId: string,
    channel: ProfileChannel,
    seedProfiles: boolean,
    executor?: ProfileReader,
    organizationUserIdOverride?: string | null,
): Promise<ProfileRecord[]> {
    if (seedProfiles) await ensureProfiles(ownerUserId);
    const organizationUserId = await organizationUserIdOr(
        organizationUserIdOverride,
    );
    if (
        organizationUserId &&
        organizationUserId !== ownerUserId &&
        isOrgScopeEnabled()
    ) {
        if (seedProfiles) await ensureProfiles(organizationUserId);
    }
    const owners = [
        ownerUserId,
        ...(organizationUserId &&
        organizationUserId !== ownerUserId &&
        isOrgScopeEnabled()
            ? [organizationUserId]
            : []),
    ];
    const pages = await Promise.all(
        owners.map((profileOwnerUserId) =>
            listProfiles({
                ownerUserId: profileOwnerUserId,
                actorUserId: ownerUserId,
                channel,
                limit: 100,
                executor,
                readOnly: !seedProfiles,
            }),
        ),
    );
    return pages.flatMap(({ items }) => items);
}

async function organizationItemProfile(input: {
    ownerUserId: string;
    itemId: string;
    channel: ProfileChannel;
    executor?: ProfileReader;
    organizationUserId?: string | null;
}): Promise<ProfileRecord | null> {
    const organizationUserId = await organizationUserIdOr(
        input.organizationUserId,
    );
    if (!organizationUserId) return null;
    for (const view of ["org", "private"] as const) {
        const [processing] = await (input.executor ?? db)
            .select({ profileId: itemProcessing.profileId })
            .from(itemProcessing)
            .where(
                and(
                    eq(itemProcessing.itemId, input.itemId),
                    eq(itemProcessing.userId, input.ownerUserId),
                    eq(itemProcessing.view, view),
                ),
            )
            .limit(1);
        if (!processing?.profileId) continue;
        const profile = await getProfile(
            organizationUserId,
            processing.profileId,
            input.ownerUserId,
            { executor: input.executor, readOnly: Boolean(input.executor) },
        );
        if (
            profile?.scope === "organization" &&
            profile.channel === input.channel
        ) {
            return profile;
        }
    }
    return null;
}

async function defaultsForPlacements(input: {
    ownerUserId: string;
    channel: ProfileChannel;
    folderIds: readonly string[];
    view: RecordingView;
    executor?: ProfileReader;
    organizationUserId?: string | null;
}): Promise<FolderDefaultOutcome[]> {
    const organizationUserId = await organizationUserIdOr(
        input.organizationUserId,
    );
    const allowedOwners =
        input.view === "org"
            ? organizationUserId
                ? [organizationUserId]
                : []
            : [
                  input.ownerUserId,
                  ...(organizationUserId &&
                  organizationUserId !== input.ownerUserId
                      ? [organizationUserId]
                      : []),
              ];
    const profiles = await Promise.all(
        [...new Set(input.folderIds)].map(async (folderId) => {
            const folder = await accessibleFolder(
                folderId,
                allowedOwners,
                input.executor,
            );
            if (!folder) return null;
            const details = await folderDefaultProfileDetails({
                folderId,
                folderOwnerUserId: folder.ownerUserId,
                actorUserId: input.ownerUserId,
                channel: input.channel,
                organizationOnly: input.view === "org",
                executor: input.executor,
                organizationUserId,
            });
            if (details?.effectiveManualOnly) {
                return { kind: "manual_only" } as const;
            }
            return details?.effective
                ? ({ kind: "profile", profile: details.effective } as const)
                : null;
        }),
    );
    return profiles.filter(
        (outcome): outcome is FolderDefaultOutcome => outcome !== null,
    );
}

async function accountDefaultProfile(input: {
    ownerUserId: string;
    actorUserId: string;
    channel: ProfileChannel;
    seedProfiles: boolean;
    throwOnUnavailable: boolean;
    executor?: ProfileReader;
    organizationUserId?: string | null;
}): Promise<ProfileRecord | null> {
    if (input.seedProfiles) await ensureProfiles(input.ownerUserId);
    if (!input.throwOnUnavailable) {
        return (
            await getDefaultProfileState(
                input.ownerUserId,
                input.channel,
                input.actorUserId,
                {
                    seed: input.seedProfiles,
                    executor: input.executor,
                    organizationUserId: input.organizationUserId,
                },
            )
        ).effective;
    }
    return getDefaultProfile(
        input.ownerUserId,
        input.channel,
        input.actorUserId,
        {
            seed: input.seedProfiles,
            executor: input.executor,
            organizationUserId: input.organizationUserId,
        },
    );
}

/**
 * Resolve the view's channel default: the owner's on the private view, the
 * Organization account's on the Organization view.
 */
export async function resolveChannelDefaultProfile(input: {
    ownerUserId: string;
    channel: ProfileChannel;
    view: RecordingView;
    seedProfiles?: boolean;
    throwOnUnavailable?: boolean;
    executor?: ProfileReader;
    organizationUserId?: string | null;
}): Promise<ProfileRecord | null> {
    const profileOwnerUserId =
        input.view === "org"
            ? await organizationUserIdOr(input.organizationUserId)
            : input.ownerUserId;
    if (!profileOwnerUserId) return null;
    return accountDefaultProfile({
        ownerUserId: profileOwnerUserId,
        actorUserId: input.ownerUserId,
        channel: input.channel,
        seedProfiles: input.seedProfiles ?? true,
        throwOnUnavailable: input.throwOnUnavailable ?? true,
        executor: input.executor,
        organizationUserId: input.organizationUserId,
    });
}

function profileCandidates(
    profiles: ProfileRecord[],
): PlacementProfileCandidate[] {
    return [
        ...profiles.map((profile) => ({ kind: "profile" as const, profile })),
        { kind: "manual_only" },
    ];
}

/** Resolve a categorization profile without throwing for human-choice outcomes. */
export async function resolveProfileForPlacements(input: {
    ownerUserId: string;
    itemId: string;
    channel: ProfileChannel;
    folderIds: readonly string[];
    view: RecordingView;
    seedProfiles?: boolean;
    throwOnUnavailable?: boolean;
    executor?: ProfileReader;
    organizationUserId?: string | null;
    ignoreItemAssignment?: boolean;
}): Promise<PlacementProfileResolution> {
    const seedProfiles = input.seedProfiles ?? true;
    if (input.view === "org" && !input.ignoreItemAssignment) {
        const itemProfile = await organizationItemProfile(input);
        if (itemProfile) {
            return {
                status: "resolved",
                profile: itemProfile,
                manualOnly: false,
                source: "default",
            };
        }
    }

    const defaults = await defaultsForPlacements(input);
    const distinctDefaults = new Map(
        defaults.map((outcome) => [
            outcome.kind === "manual_only"
                ? "manual_only"
                : `profile:${outcome.profile.id}`,
            outcome,
        ]),
    );
    if (distinctDefaults.size === 1) {
        const [outcome] = distinctDefaults.values();
        if (outcome?.kind === "profile") {
            return {
                status: "resolved",
                profile: outcome.profile,
                manualOnly: false,
                source: "folder",
            };
        }
        if (outcome?.kind === "manual_only") {
            const profile = await resolveChannelDefaultProfile({
                ...input,
                seedProfiles,
            });
            if (profile)
                return {
                    status: "resolved",
                    profile,
                    manualOnly: true,
                    source: "folder",
                };
        }
    }
    if (input.view === "org") {
        if (distinctDefaults.size === 0) {
            const organizationDefault = await resolveChannelDefaultProfile({
                ...input,
                seedProfiles,
            });
            if (organizationDefault) {
                return {
                    status: "resolved",
                    profile: organizationDefault,
                    manualOnly: false,
                    source: "default",
                };
            }
        }
        return { status: "waiting_for_curator" };
    }

    const candidates = await usableProfiles(
        input.ownerUserId,
        input.channel,
        seedProfiles,
        input.executor,
        input.organizationUserId,
    );
    if (distinctDefaults.size > 1) {
        return { status: "choose", candidates: profileCandidates(candidates) };
    }
    const ownerDefault = await resolveChannelDefaultProfile({
        ...input,
        seedProfiles,
    });
    if (ownerDefault) {
        return {
            status: "resolved",
            profile: ownerDefault,
            manualOnly: false,
            source: "default",
        };
    }
    if (candidates.length === 1) {
        const [profile] = candidates;
        if (profile) {
            return {
                status: "resolved",
                profile,
                manualOnly: false,
                source: "default",
            };
        }
    }
    return { status: "choose", candidates: profileCandidates(candidates) };
}
