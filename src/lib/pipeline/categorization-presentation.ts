import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    chatterItems,
    itemProcessing,
    mailPendingShares,
    processingProfiles,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { decryptText } from "@/lib/encryption/fields";
import { listFolderOrganization } from "@/lib/folders/folders";
import { getOrgUserId, isOrgScopeEnabled } from "@/lib/org/config";
import { resolveProfileForPlacements } from "@/lib/profiles/resolve-for-placement";
import { ensureProfiles } from "@/lib/profiles/seed";
import {
    getDefaultProfileState,
    listProfiles,
    type ProfileRecord,
} from "@/lib/profiles/store";
import type { RecordingFolder } from "@/types/folder";

export interface ProcessingProfileSummary {
    id: string;
    name: string;
    scope: "personal" | "organization";
}

export type ProcessingResolution =
    | {
          status: "resolved";
          profile: ProcessingProfileSummary;
          manualOnly: boolean;
          source: "folder" | "default" | "current";
      }
    | {
          status: "choose";
          candidates: (
              | { kind: "profile"; profile: ProcessingProfileSummary }
              | { kind: "manual_only" }
          )[];
      }
    | { status: "waiting_for_curator" };

export interface ProcessingFolderSummary {
    id: string;
    parentId: string | null;
    name: string;
    path: string;
    scope: "personal" | "org";
}

export interface CategorizationPanelPresentation {
    itemId: string;
    folders: ProcessingFolderSummary[];
    selectedFolderIds: string[];
    profiles: ProcessingProfileSummary[];
    organizationDefault?: ProcessingProfileSummary | null;
    followsOrganizationDefault?: boolean;
    defaultProfileUnavailable?: boolean;
    resolution: ProcessingResolution;
    currentProfile: ProcessingProfileSummary | null;
    currentManualOnly: boolean;
    canCreateOrganizationFolders: boolean;
}

function profileSummary(profile: ProfileRecord): ProcessingProfileSummary {
    return { id: profile.id, name: profile.name, scope: profile.scope };
}

function folderPath(
    folder: RecordingFolder,
    byId: Map<string, RecordingFolder>,
): string {
    const parts = [folder.name];
    let parentId = folder.parentId;
    while (parentId) {
        const parent = byId.get(parentId);
        if (!parent) break;
        parts.unshift(parent.name);
        parentId = parent.parentId;
    }
    return parts.join(" › ");
}

/** Serialize profile resolution without profile settings or encrypted fields. */
export function serializeProcessingResolution(
    resolution: Awaited<ReturnType<typeof resolveProfileForPlacements>>,
): ProcessingResolution {
    if (resolution.status === "resolved") {
        return {
            status: "resolved",
            profile: profileSummary(resolution.profile),
            manualOnly: resolution.manualOnly,
            source: resolution.source,
        };
    }
    if (resolution.status === "waiting_for_curator") return resolution;
    return {
        status: "choose",
        candidates: resolution.candidates.map((candidate) =>
            candidate.kind === "manual_only"
                ? candidate
                : {
                      kind: "profile" as const,
                      profile: profileSummary(candidate.profile),
                  },
        ),
    };
}

/** Load selectable folders and usable profiles only when filing is opened. */
export async function loadPrivateCategorizationPanel(
    ownerUserId: string,
    itemId: string,
): Promise<CategorizationPanelPresentation | null> {
    const [item] = await db
        .select({
            kind: chatterItems.kind,
            currentProfileId: itemProcessing.profileId,
            currentProfileName: processingProfiles.name,
            currentProfileScope: processingProfiles.scope,
            currentManualOnly: itemProcessing.manualOnly,
        })
        .from(chatterItems)
        .leftJoin(
            itemProcessing,
            and(
                eq(itemProcessing.itemId, chatterItems.id),
                eq(itemProcessing.userId, ownerUserId),
                eq(itemProcessing.view, "private"),
            ),
        )
        .leftJoin(
            processingProfiles,
            eq(processingProfiles.id, itemProcessing.profileId),
        )
        .where(
            and(
                eq(chatterItems.id, itemId),
                eq(chatterItems.userId, ownerUserId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!item) return null;

    const [orgUserId] = await Promise.all([
        getOrgUserId(),
        ensureProfiles(ownerUserId),
    ]);
    if (orgUserId && orgUserId !== ownerUserId && isOrgScopeEnabled()) {
        await ensureProfiles(orgUserId);
    }
    const profileOwners = [
        ownerUserId,
        ...(orgUserId && orgUserId !== ownerUserId && isOrgScopeEnabled()
            ? [orgUserId]
            : []),
    ];
    const [
        folderOrganization,
        profilePages,
        intents,
        canCreateOrganizationFolders,
        defaultState,
    ] = await Promise.all([
        listFolderOrganization(ownerUserId),
        Promise.all(
            profileOwners.map((profileOwnerUserId) =>
                listProfiles({
                    ownerUserId: profileOwnerUserId,
                    actorUserId: ownerUserId,
                    channel: item.kind,
                    limit: 100,
                }),
            ),
        ),
        db
            .select({ folderId: mailPendingShares.folderId })
            .from(mailPendingShares)
            .where(
                and(
                    eq(mailPendingShares.itemId, itemId),
                    eq(mailPendingShares.userId, ownerUserId),
                ),
            ),
        isOrgScopeEnabled()
            ? userCuratesOrganizationNow(ownerUserId)
            : Promise.resolve(false),
        getDefaultProfileState(ownerUserId, item.kind),
    ]);
    const byId = new Map(
        folderOrganization.folders.map((folder) => [folder.id, folder]),
    );
    const folders = folderOrganization.folders
        .filter((folder) => folder.scope === "personal" || isOrgScopeEnabled())
        .map((folder) => ({
            id: folder.id,
            parentId: folder.parentId,
            name: folder.name,
            path: folderPath(folder, byId),
            scope: folder.scope,
        }));
    const selectableFolderIds = new Set(
        folders
            .filter((folder) => folder.parentId !== null)
            .map((folder) => folder.id),
    );
    const selectedFolderIds = [
        ...folderOrganization.assignments
            .filter((assignment) => assignment.recordingId === itemId)
            .map((assignment) => assignment.folderId),
        ...intents.map((intent) => intent.folderId),
    ].filter((folderId) => selectableFolderIds.has(folderId));
    const currentProfile =
        item.currentProfileId &&
        item.currentProfileName &&
        item.currentProfileScope
            ? {
                  id: item.currentProfileId,
                  name: decryptText(item.currentProfileName),
                  scope: item.currentProfileScope,
              }
            : null;
    const resolution: ProcessingResolution = currentProfile
        ? {
              status: "resolved",
              profile: currentProfile,
              manualOnly: item.currentManualOnly ?? false,
              source: "current",
          }
        : serializeProcessingResolution(
              await resolveProfileForPlacements({
                  ownerUserId,
                  itemId,
                  channel: item.kind,
                  folderIds: selectedFolderIds,
                  view: "private",
                  seedProfiles: false,
                  throwOnUnavailable: false,
              }),
          );

    return {
        itemId,
        folders,
        selectedFolderIds,
        profiles: profilePages.flatMap((page) =>
            page.items.map(profileSummary),
        ),
        organizationDefault: defaultState.organizationDefault
            ? profileSummary(defaultState.organizationDefault)
            : null,
        followsOrganizationDefault:
            defaultState.source === "organization" && !defaultState.pointerId,
        defaultProfileUnavailable: defaultState.explicitUnavailable,
        resolution,
        currentProfile,
        currentManualOnly: item.currentManualOnly ?? false,
        canCreateOrganizationFolders,
    };
}
