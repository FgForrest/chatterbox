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
    getProfile,
    listProfiles,
    type ProfileRecord,
} from "@/lib/profiles/store";
import type { RecordingView } from "@/lib/sharing/view";

export interface FolderDefaultProfileDetails {
    own: ProfileRecord | null;
    effective: ProfileRecord | null;
    inheritedFromFolderId: string | null;
}

export type PlacementProfileResolution =
    | { status: "resolved"; profile: ProfileRecord }
    | { status: "choose"; candidates: ProfileRecord[] }
    | { status: "waiting_for_curator" };

interface FolderContext {
    id: string;
    ownerUserId: string;
    parentId: string | null;
}

async function accessibleFolder(
    folderId: string,
    allowedOwnerUserIds: readonly string[],
): Promise<FolderContext | null> {
    if (allowedOwnerUserIds.length === 0) return null;
    const [folder] = await db
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
}): Promise<ProfileRecord | null> {
    const [row] = await db
        .select({ profileId: folderDefaultProfiles.profileId })
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
    if (!row?.profileId) return null;

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
        );
        if (
            profile?.channel === input.channel &&
            (!input.organizationOnly || profile.scope === "organization")
        ) {
            return profile;
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
}): Promise<FolderDefaultProfileDetails | null> {
    const organizationUserId = await getOrgUserId();
    const folder = await accessibleFolder(input.folderId, [
        input.folderOwnerUserId,
    ]);
    if (!folder) return null;
    if (folder.parentId === null) {
        return {
            own: null,
            effective: null,
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
    });
    if (own) {
        return { own, effective: own, inheritedFromFolderId: null };
    }

    let parentId = folder.parentId;
    while (parentId) {
        const parent = await accessibleFolder(parentId, [folder.ownerUserId]);
        if (!parent || parent.parentId === null) break;
        const inherited = await usableDefaultAtFolder({
            folderId: parent.id,
            folderOwnerUserId: folder.ownerUserId,
            actorUserId: input.actorUserId,
            channel: input.channel,
            organizationUserId,
            organizationOnly: input.organizationOnly ?? false,
        });
        if (inherited) {
            return {
                own: null,
                effective: inherited,
                inheritedFromFolderId: parent.id,
            };
        }
        parentId = parent.parentId;
    }
    return { own: null, effective: null, inheritedFromFolderId: null };
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
): Promise<ProfileRecord[]> {
    await ensureProfiles(ownerUserId);
    const organizationUserId = await getOrgUserId();
    if (
        organizationUserId &&
        organizationUserId !== ownerUserId &&
        isOrgScopeEnabled()
    ) {
        await ensureProfiles(organizationUserId);
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
            }),
        ),
    );
    return pages.flatMap(({ items }) => items);
}

async function organizationItemProfile(input: {
    ownerUserId: string;
    itemId: string;
    channel: ProfileChannel;
}): Promise<ProfileRecord | null> {
    const organizationUserId = await getOrgUserId();
    if (!organizationUserId) return null;
    for (const view of ["org", "private"] as const) {
        const [processing] = await db
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
}): Promise<ProfileRecord[]> {
    const organizationUserId = await getOrgUserId();
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
            const folder = await accessibleFolder(folderId, allowedOwners);
            if (!folder) return null;
            const details = await folderDefaultProfileDetails({
                folderId,
                folderOwnerUserId: folder.ownerUserId,
                actorUserId: input.ownerUserId,
                channel: input.channel,
                organizationOnly: input.view === "org",
            });
            return details?.effective ?? null;
        }),
    );
    return profiles.filter(
        (profile): profile is ProfileRecord => profile !== null,
    );
}

/** Resolve a categorization profile without throwing for human-choice outcomes. */
export async function resolveProfileForPlacements(input: {
    ownerUserId: string;
    itemId: string;
    channel: ProfileChannel;
    folderIds: readonly string[];
    view: RecordingView;
}): Promise<PlacementProfileResolution> {
    if (input.view === "org") {
        const itemProfile = await organizationItemProfile(input);
        if (itemProfile) return { status: "resolved", profile: itemProfile };
    }

    const defaults = await defaultsForPlacements(input);
    const distinctDefaults = new Map(
        defaults.map((profile) => [profile.id, profile]),
    );
    if (distinctDefaults.size === 1) {
        const [profile] = distinctDefaults.values();
        if (profile) return { status: "resolved", profile };
    }
    if (input.view === "org") {
        return { status: "waiting_for_curator" };
    }

    const candidates = await usableProfiles(input.ownerUserId, input.channel);
    if (distinctDefaults.size > 1) {
        return { status: "choose", candidates };
    }
    if (candidates.length === 1) {
        const [profile] = candidates;
        if (profile) return { status: "resolved", profile };
    }
    return { status: "choose", candidates };
}
