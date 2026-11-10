import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { folderParticipantCondition } from "@/db/queries/folder-participants";
import { notifyFolderReceiversInTx } from "@/db/queries/item-shares";
import { lockOrgTree } from "@/db/queries/organization-tree";
import { lockPipelineTargetsInTx } from "@/db/queries/pipeline-jobs";
import { lockPrivateFolderTree } from "@/db/queries/private-folder-tree";
import { lockProfileMutation } from "@/db/queries/profile-mutations";
import {
    dropReleasedAudienceInTx,
    notifyRestrictedAudienceInTx,
    placementReleaseTimeInTx,
    placementVisibleCondition,
    type RestrictedViewer,
    restrictedFolderVisibleCondition,
    restrictedMemberCondition,
    revokePlacementExportsInTx,
} from "@/db/queries/restricted-folders";
import {
    asyncJobs,
    chatterItems,
    folderExportConfigurations,
    folderShares,
    mailPendingShares,
    meetingAgendas,
    receivedFolderAttachments,
    recordingFolderAssignments,
    recordingFolders,
    recordings,
    recordingTasks,
    restrictedFolderMembers,
    users,
} from "@/db/schema";
import { holderAccess } from "@/lib/authz/access-state";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { isSerializationFailure, retryOnDeadlock } from "@/lib/deadlock-retry";
import { decryptText, encryptText } from "@/lib/encryption/fields";
import { env } from "@/lib/env";
import { AppError, ErrorCode } from "@/lib/errors";
import { notifyPersonShareChanged } from "@/lib/events/personal";
import { enqueueExportPlansForUser } from "@/lib/folder-exports/jobs";
import {
    assertNoPendingExportRevocations,
    exportRevocationPending,
    withExportRevocationCleanup,
} from "@/lib/folder-exports/revocations";
import { assertPersonSharedFolderAllowsChildren } from "@/lib/folders/person-shared-leaf";
import {
    assertRestrictedFolderContainer,
    initializeRestrictedAudienceInTx,
    restrictedFolderNodes,
    validateRestrictedAudience,
} from "@/lib/folders/restriction";
import { isIdpAuthorization } from "@/lib/identity/factory";
import { nudge } from "@/lib/jobs/nudge";
import { lookupHash } from "@/lib/knowledge/lookup-hash";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import {
    publishKnowledgeInTx,
    withdrawKnowledgeInTx,
} from "@/lib/knowledge/share-knowledge";
import { blockFolderAddressesInTx } from "@/lib/mail/address-blocking";
import { ensureFolderAddress } from "@/lib/mail/addresses";
import { mailShareProblems, shareMailInTx } from "@/lib/mail/share-gate";
import {
    assertOrgScopeWritable,
    getOrgUserId,
    isOrgAccount,
    isOrgScopeEnabled,
} from "@/lib/org/config";
import { notifyOrgChange } from "@/lib/org/events";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { bindPlacementProfileInTx } from "@/lib/profiles/placement-binding";
import { recordingJobSubject } from "@/lib/sharing/access";
import {
    endFolderSharesInTx,
    listReceivedFolderOrganization,
    notifyFolderSharesChanged,
    sharedFolderIds,
} from "@/lib/sharing/folder-shares";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import type { ShareGateProblem } from "@/lib/sharing/share-gate";
import {
    publishSpeakerNamesInTx,
    publishTaskAssigneesInTx,
} from "@/lib/sharing/share-names";
import { isRecordingShared } from "@/lib/sharing/shared";
import {
    lockItemTaskGraphInTx,
    withdrawItemTaskHomesInTx,
} from "@/lib/tasks/mentions";
import type {
    FolderKind,
    FolderOrganization,
    FolderScope,
    RecordingFolder,
} from "@/types/folder";

export const MAX_FOLDER_NAME_LENGTH = 100;

/** Stored name of the Organization root; the UI labels roots by kind. */
export const ORG_ROOT_NAME = "Organization";

const FOLDER_ORDER_STEP = 1000;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

type RootSpec = { kind: "private" | "public"; name: string; sortOrder: number };

const PRIVATE_ROOT: RootSpec = {
    kind: "private",
    name: "Private",
    sortOrder: 0,
};
const LEGACY_PUBLIC_ROOT: RootSpec = {
    kind: "public",
    name: "Public",
    sortOrder: 1000,
};
const ORG_ROOT: RootSpec = {
    kind: "public",
    name: ORG_ROOT_NAME,
    sortOrder: 1000,
};

interface FolderRow {
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
    kind: FolderKind;
    sortOrder: number;
    version: number;
    restrictedAt: Date | null;
    restrictingAt: Date | null;
}

const folderColumns = {
    id: recordingFolders.id,
    userId: recordingFolders.userId,
    parentId: recordingFolders.parentId,
    name: recordingFolders.name,
    kind: recordingFolders.kind,
    sortOrder: recordingFolders.sortOrder,
    version: recordingFolders.version,
    restrictedAt: recordingFolders.restrictedAt,
    restrictingAt: recordingFolders.restrictingAt,
};

/**
 * A folder the caller may act on, and in which tree it lives.
 *
 * `ownerId` is whose rows the tree is made of: the caller for Private, the
 * organization account for Organization.
 */
interface AccessibleFolder {
    folder: FolderRow;
    scope: FolderScope;
    ownerId: string;
}

/** Schedule the owner's folder-export projection after a placement change. */
export async function scheduleFolderExportProjection(
    userId: string,
): Promise<void> {
    await enqueueExportPlansForUser(userId).catch((error) => {
        console.error("Failed to schedule folder export projection:", error);
    });
}

/** Invalidate authorized tree readers and Organization export projections. */
export async function orgTreeChanged(
    folderId?: string,
    options: { structural?: boolean } = {},
): Promise<void> {
    await notifyOrgChange({
        type: "tree",
        ...(folderId ? { folderId } : {}),
        ...(options.structural ? { structural: true } : {}),
    });
    const orgUserId = await getOrgUserId();
    if (orgUserId) await scheduleFolderExportProjection(orgUserId);
}

function normalizeName(value: string): string {
    const name = value.trim().replace(/\s+/g, " ");
    if (!name) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "A folder needs a name",
            400,
            { field: "name" },
        );
    }
    if (name.length > MAX_FOLDER_NAME_LENGTH) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            `Folder names must be ${MAX_FOLDER_NAME_LENGTH} characters or fewer`,
            400,
            { field: "name" },
        );
    }
    return name;
}

function serializeFolder(row: FolderRow, scope: FolderScope): RecordingFolder {
    return {
        id: row.id,
        parentId: row.parentId,
        name: decryptText(row.name),
        kind: row.kind,
        sortOrder: row.sortOrder,
        scope,
        version: row.version,
        ...(row.restrictedAt ? { restricted: true as const } : {}),
        ...(row.restrictingAt ? { restricting: true as const } : {}),
    };
}

function folderNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Folder not found", 404);
}

function staleFolder(): AppError {
    return new AppError(
        ErrorCode.CONFLICT,
        "Someone else changed this folder. Refresh and try again.",
        409,
    );
}

function rootsFor(isOrg: boolean): RootSpec[] {
    if (isOrg) return [ORG_ROOT];
    // Hosted keeps the per-user Public root it always had. Self-host replaces
    // it with the shared Organization tree.
    return env.IS_HOSTED ? [PRIVATE_ROOT, LEGACY_PUBLIC_ROOT] : [PRIVATE_ROOT];
}

async function insertRoots(
    executor: Pick<typeof db, "insert">,
    userId: string,
    roots: RootSpec[],
): Promise<void> {
    if (roots.length === 0) return;
    await executor
        .insert(recordingFolders)
        .values(
            roots.map((root) => ({
                userId,
                parentId: null,
                name: encryptText(root.name),
                nameHash: lookupHash(root.name),
                kind: root.kind,
                sortOrder: root.sortOrder,
            })),
        )
        .onConflictDoNothing();
}

/** Create the root folders an account is entitled to, if missing. */
export async function ensureRootFolders(userId: string): Promise<void> {
    await insertRoots(db, userId, rootsFor(await isOrgAccount(userId)));
}

/** Create the organization account's root inside an existing transaction. */
export async function ensureOrgRootFolder(
    tx: Pick<typeof db, "insert">,
    orgUserId: string,
): Promise<void> {
    await insertRoots(tx, orgUserId, [ORG_ROOT]);
}

async function folderCuratorAuthority(
    userId: string,
    orgUserId: string | null,
    executor: Pick<typeof db, "select">,
    known?: boolean,
) {
    if (executor === db) return known ?? userCuratesOrganizationNow(userId);
    if (!isIdpAuthorization()) return known ?? userId === orgUserId;
    if (!known) return false;
    const access = await holderAccess(userId, { executor, verify: false });
    return access.ok && access.capabilities.has("org.curate");
}

/**
 * Resolve a folder id to something the caller may act on.
 *
 * Private folders are their owner's alone. Organization folders are open to
 * every account while the scope is enabled.
 */
async function resolveFolder(
    executor: Pick<typeof db, "select">,
    userId: string,
    folderId: string,
    orgUserId: string | null,
    canCurate?: boolean,
): Promise<AccessibleFolder | null> {
    const [folder] = await executor
        .select(folderColumns)
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folderId))
        .limit(1);
    if (!folder) return null;
    if (orgUserId && folder.userId === orgUserId) {
        if (folder.restrictedAt) {
            const curator = await folderCuratorAuthority(
                userId,
                orgUserId,
                executor,
                canCurate,
            );
            if (!curator) {
                const [member] = await executor
                    .select({ id: restrictedFolderMembers.userId })
                    .from(restrictedFolderMembers)
                    .where(
                        and(
                            eq(restrictedFolderMembers.folderId, folderId),
                            eq(restrictedFolderMembers.userId, userId),
                            restrictedMemberCondition(
                                userId,
                                restrictedFolderMembers.folderId,
                            ),
                        ),
                    )
                    .limit(1);
                if (!member)
                    throw new AppError(
                        ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                        ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                        403,
                    );
            }
        }
        return { folder, scope: "org", ownerId: orgUserId };
    }
    if (folder.userId === userId) {
        // The organization account's folders are the Organization tree even
        // while the scope is hidden, so its writes still meet the read-only
        // guard instead of passing as a private tree.
        return (await isOrgAccount(userId, executor))
            ? { folder, scope: "org", ownerId: userId }
            : { folder, scope: "personal", ownerId: userId };
    }
    return null;
}

/** Resolve a folder through the tree's shared read authorization rules. */
export async function resolveReadableFolder(
    userId: string,
    folderId: string,
): Promise<AccessibleFolder | null> {
    return resolveFolder(db, userId, folderId, await getOrgUserId());
}

/**
 * The custom folder `folderId` and its subfolders as `userId` reaches them,
 * or null when they cannot; `writable` is whether they may change it now.
 */
export async function reachableCustomFolder(
    userId: string,
    folderId: string,
): Promise<{
    folderId: string;
    ownerId: string;
    scope: FolderScope;
    subtreeIds: string[];
    writable: boolean;
} | null> {
    const orgUserId = await getOrgUserId();
    const target = await resolveFolder(db, userId, folderId, orgUserId);
    if (!target || target.folder.kind !== "custom") return null;
    const viewer = {
        userId,
        isCurator: await userCuratesOrganizationNow(userId),
    };
    const folders =
        target.scope === "org"
            ? await db
                  .select(folderColumns)
                  .from(recordingFolders)
                  .where(
                      and(
                          eq(recordingFolders.userId, target.ownerId),
                          restrictedFolderVisibleCondition(viewer),
                      ),
                  )
            : await listTreeFolders(db, target.ownerId);
    return {
        folderId: target.folder.id,
        ownerId: target.ownerId,
        scope: target.scope,
        subtreeIds: [...subtreeIds(folders, target.folder.id)],
        writable: target.scope !== "org" || isOrgScopeEnabled(),
    };
}

/** Build a request-scoped check shared by folder discovery and categorization. */
export function createFolderCategorizationCheck(
    userId: string,
    authorization?: Awaited<ReturnType<typeof holderAccess>>,
    executor: Pick<typeof db, "select"> = db,
) {
    let orgCheck: Promise<void> | undefined;
    async function checkOrganization(): Promise<void> {
        assertOrgScopeWritable();
        if (isIdpAuthorization()) {
            const access =
                authorization ??
                (await holderAccess(userId, {
                    executor,
                    verify: executor === db,
                }));
            if (!access.ok || !access.capabilities.has("use")) {
                throw new AppError(
                    ErrorCode.FORBIDDEN,
                    "You can no longer file items into the Organization",
                    403,
                );
            }
        }
    }
    return async (
        folder: Pick<RecordingFolder, "parentId" | "scope" | "access">,
    ): Promise<void> => {
        if (folder.access === false)
            throw new AppError(
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                403,
            );
        if (folder.parentId === null) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "Choose a folder below Private or Organization; root folders cannot categorize items",
                400,
            );
        }
        if (folder.scope === "org") {
            orgCheck ??= checkOrganization();
            await orgCheck;
        }
    };
}

/** Load only folder metadata from the caller's trees, without item assignments. */
export async function listRecordingFolderTrees(
    userId: string,
    canCurate?: boolean,
): Promise<RecordingFolder[]> {
    const [isOrg, orgUserId] = await Promise.all([
        isOrgAccount(userId),
        getOrgUserId(),
    ]);
    const viewer = {
        userId,
        isCurator: canCurate ?? (await userCuratesOrganizationNow(userId)),
    };
    const [personal, org, received] = await Promise.all([
        isOrg ? [] : listTreeFolders(db, userId),
        orgUserId
            ? db
                  .select(folderColumns)
                  .from(recordingFolders)
                  .where(and(eq(recordingFolders.userId, orgUserId)))
            : [],
        isOrg ? { folders: [] } : listReceivedFolderOrganization(userId, false),
    ]);
    return [
        ...personal.map((row) => serializeFolder(row, "personal")),
        ...(await restrictedFolderNodes(
            org.map((row) => serializeFolder(row, "org")),
            viewer,
        )),
        ...received.folders,
    ];
}

/**
 * Return non-root folders the owner may categorize items into, in input order.
 * Private and Organization roots are deliberately not categorization targets.
 */
export async function assertCategorizableFolders(
    ownerUserId: string,
    folderIds: readonly string[],
    executor: Pick<typeof db, "select"> = db,
    canCurate?: boolean,
): Promise<Array<{ folderId: string; ownerId: string; scope: FolderScope }>> {
    const orgUserId = await getOrgUserId(executor);
    const viewer = {
        userId: ownerUserId,
        isCurator: await folderCuratorAuthority(
            ownerUserId,
            orgUserId,
            executor,
            canCurate,
        ),
    };
    const attachments = folderIds.length
        ? await executor
              .select({
                  id: receivedFolderAttachments.id,
                  folderId: folderShares.folderId,
              })
              .from(receivedFolderAttachments)
              .innerJoin(
                  folderShares,
                  and(
                      eq(folderShares.id, receivedFolderAttachments.shareId),
                      eq(folderShares.receiverUserId, ownerUserId),
                      eq(folderShares.state, "accepted"),
                  ),
              )
              .where(
                  and(
                      eq(receivedFolderAttachments.userId, ownerUserId),
                      inArray(receivedFolderAttachments.id, [...folderIds]),
                  ),
              )
        : [];
    const canonical = new Map(attachments.map((row) => [row.id, row.folderId]));
    const sourceIds = [
        ...new Set(folderIds.map((id) => canonical.get(id) ?? id)),
    ];
    const rows = sourceIds.length
        ? await executor
              .select({
                  id: recordingFolders.id,
                  userId: recordingFolders.userId,
                  parentId: recordingFolders.parentId,
                  readable: sql<boolean>`${restrictedFolderVisibleCondition(viewer)}`,
              })
              .from(recordingFolders)
              .where(
                  and(
                      inArray(recordingFolders.id, sourceIds),
                      or(
                          eq(recordingFolders.userId, ownerUserId),
                          orgUserId
                              ? eq(recordingFolders.userId, orgUserId)
                              : undefined,
                          and(
                              eq(recordingFolders.kind, "custom"),
                              folderParticipantCondition(
                                  recordingFolders.userId,
                                  ownerUserId,
                                  recordingFolders.id,
                              ),
                          ),
                      ),
                  ),
              )
        : [];
    const byId = new Map(rows.map((folder) => [folder.id, folder]));
    const folders = sourceIds.map((folderId) => {
        const folder = byId.get(folderId);
        if (!folder) throw folderNotFound();
        if (!folder.readable && folder.userId === orgUserId)
            throw new AppError(
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                403,
            );
        return {
            folderId: folder.id,
            ownerId: folder.userId,
            scope:
                orgUserId && folder.userId === orgUserId
                    ? ("org" as const)
                    : ("personal" as const),
        };
    });
    const check = createFolderCategorizationCheck(
        ownerUserId,
        undefined,
        executor,
    );
    for (const folder of folders) {
        const row = byId.get(folder.folderId);
        if (!row) throw folderNotFound();
        await check({ parentId: row.parentId, scope: folder.scope });
    }
    return folders;
}

/**
 * Return a non-root folder the owner may categorize an item into.
 * Private and Organization roots are deliberately not categorization targets.
 */
export async function assertCategorizableFolder(
    ownerUserId: string,
    folderId: string,
    executor: Pick<typeof db, "select"> = db,
    canCurate?: boolean,
): Promise<{ folderId: string; ownerId: string; scope: FolderScope }> {
    const [folder] = await assertCategorizableFolders(
        ownerUserId,
        [folderId],
        executor,
        canCurate,
    );
    if (!folder) throw folderNotFound();
    return folder;
}

/** Serialize filing with share revocation and folder deletion, then recheck participation. */
export async function lockCategorizableFolderInTx(
    tx: Tx,
    userId: string,
    folderId: string,
    allowRoot = false,
    canCurate?: boolean,
) {
    const ordinary = allowRoot
        ? await resolveFolder(
              tx,
              userId,
              folderId,
              await getOrgUserId(tx),
              canCurate,
          )
        : null;
    const target = ordinary
        ? {
              folderId: ordinary.folder.id,
              ownerId: ordinary.ownerId,
              scope: ordinary.scope,
          }
        : await assertCategorizableFolder(userId, folderId, tx, canCurate);
    const [locked] = await tx
        .select({ id: recordingFolders.id })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, target.folderId),
                eq(recordingFolders.userId, target.ownerId),
            ),
        )
        .for("update");
    if (!locked) throw folderNotFound();
    return ordinary
        ? target
        : assertCategorizableFolder(userId, target.folderId, tx, canCurate);
}

async function resolveFilingFolder(
    userId: string,
    folderId: string,
    executor: Pick<typeof db, "select"> = db,
    canCurate?: boolean,
): Promise<AccessibleFolder> {
    const ordinary = await resolveFolder(
        executor,
        userId,
        folderId,
        await getOrgUserId(executor),
        canCurate,
    );
    if (ordinary) return ordinary;
    const [target] = await assertCategorizableFolders(
        userId,
        [folderId],
        executor,
        canCurate,
    );
    const [folder] = await executor
        .select(folderColumns)
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, target.folderId),
                eq(recordingFolders.userId, target.ownerId),
            ),
        );
    if (!folder) throw folderNotFound();
    return { folder, ownerId: target.ownerId, scope: target.scope };
}

/** Validate a folder supplied at an external entry path, with a useful 400. */
export async function assertCategorizableFolderInput(
    ownerUserId: string,
    folderId: string,
) {
    try {
        return await assertCategorizableFolder(ownerUserId, folderId);
    } catch (error) {
        if (
            error instanceof AppError &&
            error.code !== ErrorCode.RESTRICTED_FOLDER_NO_ACCESS &&
            (error.statusCode === 403 || error.statusCode === 404)
        ) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "This folder does not exist or you cannot file recordings into it",
                400,
                { field: "folderId" },
            );
        }
        throw error;
    }
}

/** Changes to the Organization tree need the scope to be writable. */
function assertWritable(target: AccessibleFolder): void {
    if (target.scope === "org") assertOrgScopeWritable();
}

/** Refuse an Organization-tree change unless the actor may curate it. */
export function assertOrganizationTreeManager(
    targets: ReadonlyArray<{ scope: FolderScope }>,
    canCurate: boolean,
): void {
    if (targets.some((target) => target.scope === "org") && !canCurate) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only curators can change Organization folders",
            403,
        );
    }
}

/**
 * Serialize Organization-tree changes.
 *
 * Moves, folder deletions and unshares read assignments and then write them;
 * interleaved at read committed, a member's move could survive an owner's
 * unshare, or a folder delete could cascade away a recording moved into it a
 * moment earlier. One transaction-scoped lock rules both out.
 */
export { lockOrgTree } from "@/db/queries/organization-tree";

/**
 * Lock the recording row, as the content upserts do, so an Organization run
 * that is about to commit and an unshare cannot pass each other. A mail has
 * no recording row: its item row is locked instead.
 */
export async function lockItemForFolderMutation(
    tx: Tx,
    recordingId: string,
    ownerUserId?: string,
): Promise<void> {
    const locked = await tx
        .select({ id: recordings.id })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, recordingId),
                ownerUserId ? eq(recordings.userId, ownerUserId) : undefined,
            ),
        )
        .for("update");
    if (locked.length > 0) return;
    await tx
        .update(meetingAgendas)
        .set({
            version: sql`${meetingAgendas.version} + 1`,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(meetingAgendas.meetingItemId, recordingId),
                ownerUserId
                    ? eq(meetingAgendas.userId, ownerUserId)
                    : undefined,
                isNull(meetingAgendas.recordingItemId),
            ),
        );
    await tx
        .select({ id: chatterItems.id })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                ownerUserId ? eq(chatterItems.userId, ownerUserId) : undefined,
            ),
        )
        .for("update");
}

async function lockPlacementProfilesInTx(
    tx: Tx,
    itemId: string,
    ownerUserId: string,
    orgUserId: string,
): Promise<void> {
    await lockPipelineTargetsInTx(tx, [{ itemId, userId: ownerUserId }], true);
    for (const userId of [...new Set([ownerUserId, orgUserId])].sort())
        await lockProfileMutation(tx, userId);
}

async function lockItemTaskGraphForFolderMutation(
    tx: Tx,
    itemId: string,
): Promise<void> {
    const [item] = await tx
        .select({ ownerUserId: chatterItems.userId })
        .from(chatterItems)
        .where(eq(chatterItems.id, itemId))
        .limit(1);
    if (item) {
        await lockItemTaskGraphInTx(tx, {
            itemId,
            ownerUserId: item.ownerUserId,
        });
    }
}

async function listTreeFolders(
    executor: Pick<typeof db, "select">,
    ownerId: string,
): Promise<FolderRow[]> {
    return executor
        .select(folderColumns)
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, ownerId));
}

function subtreeIds(folders: ReadonlyArray<FolderRow>, rootId: string) {
    const ids = new Set([rootId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const folder of folders) {
            if (
                folder.parentId &&
                ids.has(folder.parentId) &&
                !ids.has(folder.id)
            ) {
                ids.add(folder.id);
                changed = true;
            }
        }
    }
    return ids;
}

/**
 * Every folder and assignment the caller can see.
 *
 * A regular account sees its Private tree plus the whole Organization tree.
 * The organization account sees only the Organization tree.
 */
export async function listFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    const [isOrg, orgUserId] = await Promise.all([
        isOrgAccount(userId),
        getOrgUserId(),
    ]);
    await insertRoots(db, userId, rootsFor(isOrg));

    const personal = isOrg
        ? { folders: [], assignments: [] }
        : await listTreeOrganization(userId, "personal", userId, true);
    const viewer = {
        userId,
        isCurator: await userCuratesOrganizationNow(userId),
    };
    const org = orgUserId
        ? await listTreeOrganization(orgUserId, "org", undefined, false, viewer)
        : { folders: [], assignments: [] };

    const [received, outgoing] = isOrg
        ? [{ folders: [], assignments: [] }, new Set<string>()]
        : await Promise.all([
              listReceivedFolderOrganization(userId),
              sharedFolderIds(userId),
          ]);
    return {
        folders: [
            ...personal.folders.map((folder) => ({
                ...folder,
                ...(outgoing.has(folder.id) ? { sharedWithPeople: true } : {}),
                ...(folder.parentId && outgoing.has(folder.parentId)
                    ? { insideSharedFolder: true }
                    : {}),
            })),
            ...org.folders,
            ...received.folders.map((folder) => ({
                ...folder,
                ...(folder.parentId && outgoing.has(folder.parentId)
                    ? { insideSharedFolder: true }
                    : {}),
            })),
        ],
        assignments: [
            ...personal.assignments,
            ...org.assignments,
            ...received.assignments,
        ],
    };
}

/**
 * The caller's Private tree only. For per-user consumers -- filesystem
 * exports, the backup archive -- that must never see Organization folders.
 */
export async function listPersonalFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    await insertRoots(db, userId, rootsFor(await isOrgAccount(userId)));
    return listTreeOrganization(userId, "personal", userId);
}

/**
 * The tree a filesystem export of `userId` projects: their Private tree, or
 * for the organization account the whole Organization tree with everyone's
 * shared recordings.
 */
export async function listExportFolderOrganization(
    userId: string,
): Promise<FolderOrganization> {
    if (await isOrgAccount(userId)) {
        await insertRoots(db, userId, [ORG_ROOT]);
        return listTreeOrganization(userId, "org");
    }
    return listPersonalFolderOrganization(userId);
}

async function listTreeOrganization(
    ownerId: string,
    scope: FolderScope,
    assignmentUserId?: string,
    includeParticipants = false,
    viewer?: RestrictedViewer,
): Promise<FolderOrganization> {
    const [folderRows, assignmentRows] = await Promise.all([
        scope === "org"
            ? db
                  .select(folderColumns)
                  .from(recordingFolders)
                  .where(
                      and(
                          eq(recordingFolders.userId, ownerId),
                          viewer
                              ? undefined
                              : and(
                                    isNull(recordingFolders.restrictedAt),
                                    isNull(recordingFolders.restrictingAt),
                                ),
                      ),
                  )
            : listTreeFolders(db, ownerId),
        db
            .select({
                recordingId: recordingFolderAssignments.itemId,
                folderId: recordingFolderAssignments.folderId,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .innerJoin(
                chatterItems,
                and(
                    eq(chatterItems.id, recordingFolderAssignments.itemId),
                    eq(chatterItems.userId, recordingFolderAssignments.userId),
                ),
            )
            .where(
                and(
                    eq(recordingFolders.userId, ownerId),
                    scope === "org"
                        ? viewer
                            ? placementVisibleCondition(viewer)
                            : and(
                                  eq(
                                      recordingFolderAssignments.withheld,
                                      false,
                                  ),
                                  isNull(recordingFolders.restrictedAt),
                                  isNull(recordingFolders.restrictingAt),
                              )
                        : undefined,
                    isNull(chatterItems.deletedAt),
                    assignmentUserId
                        ? includeParticipants
                            ? folderParticipantCondition(
                                  recordingFolders.userId,
                                  recordingFolderAssignments.userId,
                                  recordingFolders.id,
                              )
                            : eq(
                                  recordingFolderAssignments.userId,
                                  assignmentUserId,
                              )
                        : undefined,
                ),
            ),
    ]);
    const folders = folderRows.map((row) => serializeFolder(row, scope));
    return {
        folders: viewer
            ? await restrictedFolderNodes(folders, viewer)
            : folders,
        assignments: assignmentRows,
    };
}

export async function createFolder(input: {
    userId: string;
    parentId: string;
    name: string;
    restricted?: boolean;
    audienceUserIds?: string[];
    canCurate?: boolean;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const orgUserId = await getOrgUserId();
    const parent = await resolveFolder(
        db,
        input.userId,
        input.parentId,
        orgUserId,
    );
    if (!parent) {
        throw new AppError(ErrorCode.NOT_FOUND, "Parent folder not found", 404);
    }
    assertWritable(parent);
    if (parent.scope === "org" && parent.folder.parentId === null) {
        assertOrganizationTreeManager([parent], input.canCurate === true);
    }

    if (input.restricted && parent.scope !== "org")
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            ErrorCode.INVALID_INPUT,
            400,
        );
    const audience = input.restricted
        ? await validateRestrictedAudience(input.audienceUserIds ?? [])
        : [];
    const created = await db.transaction(async (tx) => {
        if (parent.scope === "org") await lockOrgTree(tx);
        if (parent.scope === "personal")
            await lockPrivateFolderTree(tx, input.userId);
        await assertPersonSharedFolderAllowsChildren(tx, parent);
        const [current] = await tx
            .select({
                restrictedAt: recordingFolders.restrictedAt,
                restrictingAt: recordingFolders.restrictingAt,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.id, parent.folder.id));
        if (!current) throw folderNotFound();
        assertRestrictedFolderContainer(current);
        const siblings = await tx
            .select({ sortOrder: recordingFolders.sortOrder })
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, parent.ownerId),
                    eq(recordingFolders.parentId, parent.folder.id),
                ),
            );
        const sortOrder =
            siblings.reduce(
                (highest, sibling) => Math.max(highest, sibling.sortOrder),
                -FOLDER_ORDER_STEP,
            ) + FOLDER_ORDER_STEP;

        const [created] = await tx
            .insert(recordingFolders)
            .values({
                userId: parent.ownerId,
                parentId: parent.folder.id,
                name: encryptText(name),
                nameHash: lookupHash(name),
                kind: "custom",
                sortOrder,
                createdByUserId: input.userId,
                restrictedAt: input.restricted ? new Date() : null,
            })
            .returning(folderColumns);
        if (!created) {
            throw new AppError(
                ErrorCode.INTERNAL_ERROR,
                "Folder could not be created",
                500,
            );
        }
        if (input.restricted)
            await initializeRestrictedAudienceInTx(
                tx,
                created.id,
                input.userId,
                audience,
            );
        return created;
    });
    if (parent.scope === "org")
        await orgTreeChanged(input.restricted ? created.id : undefined, {
            structural: true,
        });
    try {
        await ensureFolderAddress(created.id, input.userId);
    } catch (error) {
        // The startup backfill assigns it later.
        console.error("[mail] could not assign the folder's address:", error);
    }
    return {
        ...serializeFolder(created, parent.scope),
        ...(input.restricted ? { restrictedRole: "manager" as const } : {}),
    };
}

export async function renameFolder(input: {
    userId: string;
    folderId: string;
    name: string;
    canCurate?: boolean;
    /** The version the caller last saw; a mismatch is a 409. */
    version?: number;
}): Promise<RecordingFolder> {
    const name = normalizeName(input.name);
    const orgUserId = await getOrgUserId();
    const target = await resolveFolder(
        db,
        input.userId,
        input.folderId,
        orgUserId,
    );
    if (!target || target.folder.kind !== "custom") throw folderNotFound();
    assertWritable(target);
    assertOrganizationTreeManager([target], input.canCurate === true);
    if (
        input.version !== undefined &&
        input.version !== target.folder.version
    ) {
        throw staleFolder();
    }

    const [updated] = await db
        .update(recordingFolders)
        .set({
            name: encryptText(name),
            nameHash: lookupHash(name),
            version: target.folder.version + 1,
            updatedAt: new Date(),
        })
        .where(
            and(
                eq(recordingFolders.id, target.folder.id),
                eq(recordingFolders.userId, target.ownerId),
                eq(recordingFolders.version, target.folder.version),
            ),
        )
        .returning(folderColumns);
    if (!updated) throw staleFolder();

    if (target.scope === "org") {
        await orgTreeChanged(
            target.folder.restrictedAt ? target.folder.id : undefined,
            { structural: true },
        );
    } else {
        await scheduleFolderExportProjection(input.userId);
        await notifyFolderSharesChanged(input.userId);
    }
    return serializeFolder(updated, target.scope);
}

export async function moveFolder(input: {
    userId: string;
    folderId: string;
    parentId: string;
    beforeId?: string | null;
    canCurate?: boolean;
    /** The version the caller last saw; a mismatch is a 409. */
    version?: number;
}): Promise<RecordingFolder> {
    const orgUserId = await getOrgUserId();
    const canReadRestricted =
        input.canCurate === true ||
        (!isIdpAuthorization() && input.userId === orgUserId);
    const moved = await retryOnDeadlock(
        () =>
            db.transaction(
                async (tx) => {
                    if (orgUserId) await lockOrgTree(tx);
                    await lockPrivateFolderTree(tx, input.userId);
                    const target = await resolveFolder(
                        tx,
                        input.userId,
                        input.folderId,
                        orgUserId,
                        canReadRestricted,
                    );
                    if (!target || target.folder.kind !== "custom") {
                        throw folderNotFound();
                    }
                    assertWritable(target);
                    const destination = await resolveFolder(
                        tx,
                        input.userId,
                        input.parentId,
                        orgUserId,
                        canReadRestricted,
                    );
                    if (!destination) throw folderNotFound();
                    assertRestrictedFolderContainer(destination.folder);
                    await assertPersonSharedFolderAllowsChildren(
                        tx,
                        destination,
                        target.folder.parentId,
                    );
                    assertWritable(destination);
                    assertOrganizationTreeManager(
                        [target, destination],
                        input.canCurate === true,
                    );
                    if (
                        input.version !== undefined &&
                        input.version !== target.folder.version
                    ) {
                        throw staleFolder();
                    }
                    if (target.ownerId !== destination.ownerId)
                        throw folderNotFound();
                    const folders = await listTreeFolders(tx, target.ownerId);
                    const folder = folders.find(
                        (item) => item.id === input.folderId,
                    );
                    const parent = folders.find(
                        (item) => item.id === input.parentId,
                    );
                    if (!folder || !parent) throw folderNotFound();
                    if (folder.id === parent.id) {
                        throw new AppError(
                            ErrorCode.INVALID_INPUT,
                            "A folder cannot contain itself",
                            400,
                        );
                    }

                    const byId = new Map(
                        folders.map((item) => [item.id, item]),
                    );
                    let ancestor: FolderRow | undefined = parent;
                    while (ancestor) {
                        if (ancestor.id === folder.id) {
                            throw new AppError(
                                ErrorCode.INVALID_INPUT,
                                "A folder cannot be moved inside one of its subfolders",
                                400,
                            );
                        }
                        ancestor = ancestor.parentId
                            ? byId.get(ancestor.parentId)
                            : undefined;
                    }

                    let destinationRoot = parent;
                    while (destinationRoot.parentId) {
                        const next = byId.get(destinationRoot.parentId);
                        if (!next) break;
                        destinationRoot = next;
                    }
                    if (destinationRoot.kind !== "private") {
                        const configured = await tx
                            .select({ id: folderExportConfigurations.id })
                            .from(folderExportConfigurations)
                            .where(
                                inArray(folderExportConfigurations.folderId, [
                                    ...subtreeIds(folders, folder.id),
                                ]),
                            )
                            .limit(1);
                        if (configured.length > 0) {
                            throw new AppError(
                                ErrorCode.INVALID_INPUT,
                                "Remove filesystem exports before moving this folder outside Private",
                                400,
                            );
                        }
                        await tx
                            .update(recordingTasks)
                            .set({
                                folderId: null,
                                version: sql`${recordingTasks.version} + 1`,
                                updatedAt: new Date(),
                            })
                            .where(
                                and(
                                    eq(recordingTasks.userId, target.ownerId),
                                    eq(recordingTasks.source, "personal"),
                                    inArray(recordingTasks.folderId, [
                                        ...subtreeIds(folders, folder.id),
                                    ]),
                                ),
                            );
                    }

                    const siblings = folders
                        .filter(
                            (item) =>
                                item.parentId === parent.id &&
                                item.id !== folder.id,
                        )
                        .sort(
                            (left, right) =>
                                left.sortOrder - right.sortOrder ||
                                decryptText(left.name).localeCompare(
                                    decryptText(right.name),
                                ),
                        );
                    let insertionIndex = siblings.length;
                    if (input.beforeId != null) {
                        insertionIndex = siblings.findIndex(
                            (item) => item.id === input.beforeId,
                        );
                        if (insertionIndex < 0) {
                            throw new AppError(
                                ErrorCode.INVALID_INPUT,
                                "The requested folder position is invalid",
                                400,
                            );
                        }
                    }
                    siblings.splice(insertionIndex, 0, {
                        ...folder,
                        parentId: parent.id,
                    });

                    for (const [index, sibling] of siblings.entries()) {
                        await tx
                            .update(recordingFolders)
                            .set({
                                parentId: parent.id,
                                sortOrder: index * FOLDER_ORDER_STEP,
                                ...(sibling.id === folder.id
                                    ? {
                                          updatedAt: new Date(),
                                          version: folder.version + 1,
                                      }
                                    : {}),
                            })
                            .where(
                                and(
                                    eq(recordingFolders.id, sibling.id),
                                    eq(recordingFolders.userId, target.ownerId),
                                ),
                            );
                    }

                    const movedIndex = siblings.findIndex(
                        (sibling) => sibling.id === folder.id,
                    );
                    if (movedIndex < 0) {
                        throw new AppError(
                            ErrorCode.INTERNAL_ERROR,
                            "Folder position could not be saved",
                            500,
                        );
                    }
                    return {
                        scope: target.scope,
                        folder: serializeFolder(
                            {
                                ...folder,
                                parentId: parent.id,
                                sortOrder: movedIndex * FOLDER_ORDER_STEP,
                                version: folder.version + 1,
                            },
                            target.scope,
                        ),
                    };
                },
                { isolationLevel: "serializable" },
            ),
        { retrySerialization: true },
    ).catch((error: unknown) => {
        if (isSerializationFailure(error))
            throw new AppError(
                ErrorCode.CONFLICT,
                "Folder changes are busy. Try again.",
                409,
                { retryable: true },
            );
        throw error;
    });
    if (moved.scope === "org") {
        await orgTreeChanged(
            moved.folder.restricted ? moved.folder.id : undefined,
            { structural: true },
        );
    } else {
        await scheduleFolderExportProjection(input.userId);
    }
    return moved.folder;
}

/**
 * Delete a folder and its subfolders.
 *
 * In the Organization tree nothing is unshared by it: every recording filed
 * anywhere in the subtree lands in the Organization root instead. Folders
 * holding an export configuration can only be deleted by the organization
 * account, which is the one that configured it.
 */
export async function deleteFolder(
    userId: string,
    folderId: string,
    { canCurate = false }: { canCurate?: boolean } = {},
): Promise<void> {
    const orgUserId = await getOrgUserId();
    const canReadRestricted =
        canCurate || (!isIdpAuthorization() && userId === orgUserId);
    const preflight = await resolveFolder(
        db,
        userId,
        folderId,
        orgUserId,
        canReadRestricted,
    );
    if (!preflight || preflight.folder.kind !== "custom")
        throw folderNotFound();
    assertWritable(preflight);
    assertOrganizationTreeManager([preflight], canCurate);
    const subtree = [
        ...subtreeIds(await listTreeFolders(db, preflight.ownerId), folderId),
    ];
    const configurations = await db
        .select({
            id: folderExportConfigurations.id,
            userId: folderExportConfigurations.userId,
        })
        .from(folderExportConfigurations)
        .where(inArray(folderExportConfigurations.folderId, subtree));
    if (
        preflight.scope === "org" &&
        userId !== orgUserId &&
        configurations.length
    )
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the organization account can delete a folder that is exported",
            403,
        );
    const deleted = await withExportRevocationCleanup(configurations, () =>
        db.transaction(async (tx) => {
            if (orgUserId) await lockOrgTree(tx);
            await lockPrivateFolderTree(tx, userId);
            const target = await resolveFolder(
                tx,
                userId,
                folderId,
                orgUserId,
                canReadRestricted,
            );
            if (!target || target.folder.kind !== "custom")
                throw folderNotFound();
            assertWritable(target);
            assertOrganizationTreeManager([target], canCurate);

            if (target.scope === "org" && orgUserId) {
                const folders = await listTreeFolders(tx, orgUserId);
                const subtree = [...subtreeIds(folders, target.folder.id)];
                if (userId !== orgUserId) {
                    const configured = await tx
                        .select({ id: folderExportConfigurations.id })
                        .from(folderExportConfigurations)
                        .where(
                            inArray(
                                folderExportConfigurations.folderId,
                                subtree,
                            ),
                        )
                        .limit(1);
                    if (configured.length > 0) {
                        throw new AppError(
                            ErrorCode.FORBIDDEN,
                            "Only the organization account can delete a folder that is exported",
                            403,
                        );
                    }
                }
                const root = folders.find(
                    (folder) =>
                        folder.parentId === null && folder.kind === "public",
                );
                if (root) {
                    const displaced = await tx
                        .select({
                            userId: recordingFolderAssignments.userId,
                            recordingId: recordingFolderAssignments.itemId,
                            releasedAt: recordingFolderAssignments.releasedAt,
                        })
                        .from(recordingFolderAssignments)
                        .where(
                            and(
                                inArray(
                                    recordingFolderAssignments.folderId,
                                    subtree,
                                ),
                                eq(recordingFolderAssignments.withheld, false),
                            ),
                        );
                    const remainingOrgFolders = folders
                        .filter((folder) => !subtree.includes(folder.id))
                        .map((folder) => folder.id);
                    const stillFiled =
                        displaced.length > 0 && remainingOrgFolders.length > 0
                            ? await tx
                                  .select({
                                      recordingId:
                                          recordingFolderAssignments.itemId,
                                  })
                                  .from(recordingFolderAssignments)
                                  .where(
                                      and(
                                          eq(
                                              recordingFolderAssignments.withheld,
                                              false,
                                          ),
                                          inArray(
                                              recordingFolderAssignments.itemId,
                                              displaced.map(
                                                  (row) => row.recordingId,
                                              ),
                                          ),
                                          inArray(
                                              recordingFolderAssignments.folderId,
                                              remainingOrgFolders,
                                          ),
                                      ),
                                  )
                            : [];
                    const filed = new Set(
                        stillFiled.map((row) => row.recordingId),
                    );
                    const toRoot = new Map<
                        string,
                        { userId: string; releasedAt: Date | null }
                    >();
                    for (const row of displaced) {
                        if (!filed.has(row.recordingId)) {
                            const previous = toRoot.get(row.recordingId);
                            toRoot.set(row.recordingId, {
                                userId: row.userId,
                                releasedAt: previous
                                    ? previous.releasedAt && row.releasedAt
                                        ? new Date(
                                              Math.min(
                                                  previous.releasedAt.getTime(),
                                                  row.releasedAt.getTime(),
                                              ),
                                          )
                                        : null
                                    : row.releasedAt,
                            });
                        }
                    }
                    if (toRoot.size > 0) {
                        await tx
                            .insert(recordingFolderAssignments)
                            .values(
                                [...toRoot].map(([recordingId, placement]) => ({
                                    userId: placement.userId,
                                    releasedAt: placement.releasedAt,
                                    itemId: recordingId,
                                    folderId: root.id,
                                })),
                            )
                            .onConflictDoNothing();
                    }
                }
            }

            const deletedFolderIds = [
                ...subtreeIds(
                    await listTreeFolders(tx, target.ownerId),
                    target.folder.id,
                ),
            ];
            const currentConfigurations = await tx
                .select({
                    id: folderExportConfigurations.id,
                    userId: folderExportConfigurations.userId,
                })
                .from(folderExportConfigurations)
                .where(
                    inArray(
                        folderExportConfigurations.folderId,
                        deletedFolderIds,
                    ),
                );
            if (
                currentConfigurations.some(
                    (configuration) =>
                        !configurations.some(
                            (locked) => locked.id === configuration.id,
                        ),
                )
            )
                throw exportRevocationPending();
            await assertNoPendingExportRevocations(tx, currentConfigurations);
            await tx
                .select({ id: recordingFolders.id })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.userId, target.ownerId),
                        inArray(recordingFolders.id, deletedFolderIds),
                    ),
                )
                .orderBy(recordingFolders.id)
                .for("update");
            await notifyRestrictedAudienceInTx(tx, deletedFolderIds);
            const receivers = await endFolderSharesInTx(
                tx,
                target.ownerId,
                deletedFolderIds,
            );
            // Its addresses and its subfolders' stop working for good, before the
            // cascade would leave them pointing nowhere.
            await blockFolderAddressesInTx(tx, deletedFolderIds);
            await tx
                .update(recordingTasks)
                .set({
                    folderId: null,
                    version: sql`${recordingTasks.version} + 1`,
                    updatedAt: new Date(),
                })
                .where(
                    and(
                        eq(recordingTasks.userId, target.ownerId),
                        eq(recordingTasks.source, "personal"),
                        inArray(recordingTasks.folderId, [
                            ...subtreeIds(
                                await listTreeFolders(tx, target.ownerId),
                                target.folder.id,
                            ),
                        ]),
                    ),
                );
            await tx
                .delete(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, target.folder.id),
                        eq(recordingFolders.userId, target.ownerId),
                    ),
                );
            return {
                scope: target.scope,
                receivers,
                restrictedFolderId: target.folder.restrictedAt
                    ? target.folder.id
                    : undefined,
            };
        }),
    );
    await Promise.all(deleted.receivers.map(notifyPersonShareChanged));
    if (deleted.scope === "org") {
        await orgTreeChanged(deleted.restrictedFolderId, { structural: true });
    } else {
        await scheduleFolderExportProjection(userId);
    }
}

/** The caller's live item `recordingId`, by kind; 404 when there is none. */
async function requireOwnedRecording(
    executor: Pick<typeof db, "select">,
    userId: string,
    recordingId: string,
    allowAbsorbedMeeting = false,
): Promise<"audio" | "mail" | "meeting"> {
    const [item] = await executor
        .select({ kind: chatterItems.kind })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, userId),
                or(
                    isNull(chatterItems.deletedAt),
                    allowAbsorbedMeeting
                        ? and(
                              eq(chatterItems.kind, "meeting"),
                              sql`exists (select 1 from ${meetingAgendas} where ${meetingAgendas.meetingItemId} = ${chatterItems.id} and ${meetingAgendas.userId} = ${userId} and ${meetingAgendas.recordingItemId} is not null)`,
                          )
                        : undefined,
                ),
            ),
        )
        .limit(1);
    if (!item) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    return item.kind;
}

/** Drop assignments to ancestors of another assignment in the same tree. */
export async function pruneRedundantAssignmentsInTx(
    tx: Tx,
    treeOwnerId: string,
    recordingId: string,
): Promise<void> {
    const [folders, assignments] = await Promise.all([
        tx
            .select({
                id: recordingFolders.id,
                parentId: recordingFolders.parentId,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, treeOwnerId)),
        tx
            .select({
                folderId: recordingFolderAssignments.folderId,
                userId: recordingFolderAssignments.userId,
                withheld: recordingFolderAssignments.withheld,
            })
            .from(recordingFolderAssignments)
            .innerJoin(
                recordingFolders,
                eq(recordingFolders.id, recordingFolderAssignments.folderId),
            )
            .where(
                and(
                    eq(recordingFolders.userId, treeOwnerId),
                    eq(recordingFolderAssignments.itemId, recordingId),
                ),
            ),
    ]);
    const selected = new Set(
        assignments
            .filter((item) => !item.withheld)
            .map((item) => item.folderId),
    );
    const byId = new Map(folders.map((item) => [item.id, item]));
    const redundant = new Set<string>();
    for (const assignment of assignments) {
        if (assignment.withheld) continue;
        let current = byId.get(assignment.folderId);
        while (current?.parentId) {
            if (selected.has(current.parentId)) {
                redundant.add(current.parentId);
            }
            current = byId.get(current.parentId);
        }
    }
    if (redundant.size > 0) {
        for (const assignment of assignments)
            if (redundant.has(assignment.folderId))
                await notifyFolderReceiversInTx(
                    tx,
                    assignment.userId,
                    recordingId,
                    assignment.folderId,
                );
        await tx
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, recordingId),
                    inArray(recordingFolderAssignments.folderId, [
                        ...redundant,
                    ]),
                ),
            );
    }
}

/**
 * Share an owner's item into one Organization folder in the caller's
 * transaction. Takes the Organization tree, people and item locks in the
 * established order. A refused gate returns its problems without writing.
 */
export async function shareItemToOrganizationFolderInTx(
    tx: Tx,
    input: {
        ownerUserId: string;
        itemId: string;
        folderId: string;
        orgUserId: string;
        canReadRestricted?: boolean;
    },
): Promise<ShareGateProblem[]> {
    await lockOrgTree(tx);
    await lockOrgPeople(tx);
    await lockItemForFolderMutation(tx, input.itemId, input.ownerUserId);
    await lockPlacementProfilesInTx(
        tx,
        input.itemId,
        input.ownerUserId,
        input.orgUserId,
    );
    const [folder] = await tx
        .select({
            id: recordingFolders.id,
            restrictedAt: recordingFolders.restrictedAt,
            restrictingAt: recordingFolders.restrictingAt,
        })
        .from(recordingFolders)
        .where(
            and(
                eq(recordingFolders.id, input.folderId),
                eq(recordingFolders.userId, input.orgUserId),
            ),
        )
        .limit(1);
    if (!folder) throw folderNotFound();
    const kind = await requireOwnedRecording(
        tx,
        input.ownerUserId,
        input.itemId,
        true,
    );
    if (folder.restrictedAt || folder.restrictingAt) {
        const [member] = await tx
            .select({ id: restrictedFolderMembers.userId })
            .from(restrictedFolderMembers)
            .where(
                and(
                    eq(restrictedFolderMembers.folderId, folder.id),
                    eq(restrictedFolderMembers.userId, input.ownerUserId),
                ),
            );
        if (
            !member &&
            !(await folderCuratorAuthority(
                input.ownerUserId,
                input.orgUserId,
                tx,
                input.canReadRestricted,
            ))
        )
            throw new AppError(
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                ErrorCode.RESTRICTED_FOLDER_NO_ACCESS,
                403,
            );
        await tx
            .insert(restrictedFolderMembers)
            .values({
                folderId: folder.id,
                userId: input.ownerUserId,
                role: "member",
                addedByUserId: input.ownerUserId,
            })
            .onConflictDoNothing();
        await tx
            .insert(recordingFolderAssignments)
            .values({
                userId: input.ownerUserId,
                itemId: input.itemId,
                folderId: folder.id,
                withheld: true,
            })
            .onConflictDoNothing();
        await notifyRestrictedAudienceInTx(tx, folder.id);
        await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.ownerUserId,
            view: "private",
            reason: "placement",
        });
        return [];
    }
    const releasedAt = await placementReleaseTimeInTx(
        tx,
        input.ownerUserId,
        input.itemId,
        input.orgUserId,
    );
    if (kind === "meeting") {
        await tx
            .insert(recordingFolderAssignments)
            .values({
                userId: input.ownerUserId,
                itemId: input.itemId,
                folderId: folder.id,
                releasedAt,
            })
            .onConflictDoUpdate({
                target: [
                    recordingFolderAssignments.itemId,
                    recordingFolderAssignments.folderId,
                ],
                set: { withheld: false, releasedAt },
                setWhere: eq(recordingFolderAssignments.withheld, true),
            });
        await notifyRestrictedAudienceInTx(tx, folder.id);
        await dropReleasedAudienceInTx(tx, folder.id);
        await pruneRedundantAssignmentsInTx(tx, input.orgUserId, input.itemId);
        await notifyFolderReceiversInTx(tx, input.ownerUserId, input.itemId);
        return [];
    }
    const wasShared = await isRecordingShared(
        input.itemId,
        input.orgUserId,
        tx,
    );
    const problems = wasShared
        ? []
        : kind === "mail"
          ? await mailShareProblems(tx, input.itemId, input.ownerUserId)
          : await loadShareGate(tx, input.itemId, input.ownerUserId);
    if (problems.length > 0) return problems;

    if (kind === "mail") {
        try {
            await shareMailInTx(tx, {
                ownerUserId: input.ownerUserId,
                itemId: input.itemId,
                folderId: folder.id,
                orgUserId: input.orgUserId,
            });
        } catch (error) {
            if (
                error instanceof AppError &&
                error.code === ErrorCode.SHARE_REQUIREMENTS_UNMET
            ) {
                return mailShareProblems(tx, input.itemId, input.ownerUserId);
            }
            throw error;
        }
        await pruneRedundantAssignmentsInTx(tx, input.orgUserId, input.itemId);
        await requestAdvanceInTx(tx, {
            itemId: input.itemId,
            userId: input.ownerUserId,
            view: "private",
            reason: "placement",
        });
        await bindPlacementProfileInTx(tx, input);
        return [];
    }

    await tx
        .insert(recordingFolderAssignments)
        .values({
            userId: input.ownerUserId,
            itemId: input.itemId,
            folderId: folder.id,
            releasedAt,
        })
        .onConflictDoUpdate({
            target: [
                recordingFolderAssignments.itemId,
                recordingFolderAssignments.folderId,
            ],
            set: { withheld: false, releasedAt },
            setWhere: eq(recordingFolderAssignments.withheld, true),
        });
    await notifyRestrictedAudienceInTx(tx, folder.id);
    await dropReleasedAudienceInTx(tx, folder.id);
    await pruneRedundantAssignmentsInTx(tx, input.orgUserId, input.itemId);
    await requestAdvanceInTx(tx, {
        itemId: input.itemId,
        userId: input.ownerUserId,
        view: "private",
        reason: "placement",
    });
    if (wasShared) {
        await bindPlacementProfileInTx(tx, input);
        return [];
    }

    const names = await publishSpeakerNamesInTx(tx, {
        recordingId: input.itemId,
        ownerUserId: input.ownerUserId,
        orgUserId: input.orgUserId,
    });
    const knowledge = await publishKnowledgeInTx(tx, {
        recordingId: input.itemId,
        ownerUserId: input.ownerUserId,
        orgUserId: input.orgUserId,
    });
    const assignees = await publishTaskAssigneesInTx(tx, {
        recordingId: input.itemId,
        ownerUserId: input.ownerUserId,
        orgUserId: input.orgUserId,
    });
    await bumpScopeInTx(tx, [
        ...names.scopes,
        ...knowledge.scopes,
        ...assignees,
    ]);
    await bindPlacementProfileInTx(tx, input);
    return [];
}

/**
 * File a recording in a folder.
 *
 * Filing in the Organization tree is sharing, so only the owner may do it.
 * The first Organization folder shares the recording, in one transaction:
 * the assignment, the share gate on the owner's rows (which are what the
 * Organization reads: a shared recording is one recording), and the
 * publishing of its speaker names, so what gets published is exactly what
 * passed. A refused share leaves nothing behind. Filing an already shared
 * recording into another Organization folder is not gated.
 */
export async function addRecordingToFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
}): Promise<void> {
    const target = await resolveFilingFolder(input.userId, input.folderId);
    if (!target) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    const canReadRestricted = await userCuratesOrganizationNow(input.userId);
    const kind = await requireOwnedRecording(
        db,
        input.userId,
        input.recordingId,
    );
    if (target.folder.kind === "private") {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Every recording already appears in Private",
            400,
        );
    }
    assertWritable(target);

    const problems = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            if (target.scope === "org") {
                return shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId: input.userId,
                    itemId: input.recordingId,
                    folderId: target.folder.id,
                    orgUserId: target.ownerId,
                    canReadRestricted,
                });
            }
            await lockCategorizableFolderInTx(
                tx,
                input.userId,
                target.folder.id,
                true,
            );
            await lockItemForFolderMutation(
                tx,
                input.recordingId,
                input.userId,
            );
            // Deleted, or given away, since the check above.
            await requireOwnedRecording(tx, input.userId, input.recordingId);
            await tx
                .insert(recordingFolderAssignments)
                .values({
                    userId: input.userId,
                    itemId: input.recordingId,
                    folderId: target.folder.id,
                })
                .onConflictDoNothing();
            await pruneRedundantAssignmentsInTx(
                tx,
                target.ownerId,
                input.recordingId,
            );
            await notifyFolderReceiversInTx(
                tx,
                input.userId,
                input.recordingId,
                target.folder.id,
            );
            await requestAdvanceInTx(tx, {
                itemId: input.recordingId,
                userId: input.userId,
                view: "private",
                reason: "placement",
            });
            return [];
        }),
    );
    if (problems.length > 0) {
        throw new AppError(
            ErrorCode.SHARE_REQUIREMENTS_UNMET,
            kind === "mail"
                ? "Finish the review before sharing"
                : "Name every speaker and finish the review before sharing",
            409,
            { problems },
        );
    }
    nudge();
    if (target.scope === "org") {
        await orgTreeChanged(target.folder.id);
    } else {
        await scheduleFolderExportProjection(input.userId);
    }
}

/**
 * Take a recording out of one folder.
 *
 * In the Organization tree only the owner may do this. When it was the last
 * Organization folder, the recording is withdrawn, which `withdraw` must
 * confirm: it is the owner's again, as the Organization left it.
 */
export async function removeRecordingFromFolder(input: {
    userId: string;
    recordingId: string;
    folderId: string;
    /**
     * The owner, or the organization account, confirmed that leaving the
     * last Organization folder withdraws it.
     */
    withdraw?: boolean;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    const target = await resolveFilingFolder(
        input.userId,
        input.folderId,
    ).catch((error) => {
        if (error instanceof AppError && error.statusCode === 404) return null;
        throw error;
    });
    if (!target) return;

    if (target.scope === "personal") {
        const unfiledOwner = await db.transaction(async (tx) => {
            await lockCategorizableFolderInTx(
                tx,
                input.userId,
                target.folder.id,
                true,
            );
            const [assignment] = await tx
                .select({ userId: recordingFolderAssignments.userId })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(
                            recordingFolderAssignments.folderId,
                            target.folder.id,
                        ),
                        target.ownerId === input.userId
                            ? undefined
                            : eq(
                                  recordingFolderAssignments.userId,
                                  input.userId,
                              ),
                    ),
                );
            if (!assignment) return;
            await lockItemForFolderMutation(
                tx,
                input.recordingId,
                assignment.userId,
            );
            await notifyFolderReceiversInTx(
                tx,
                assignment.userId,
                input.recordingId,
                target.folder.id,
            );
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.userId,
                            assignment.userId,
                        ),
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(
                            recordingFolderAssignments.folderId,
                            target.folder.id,
                        ),
                    ),
                );
            await requestAdvanceInTx(tx, {
                itemId: input.recordingId,
                userId: assignment.userId,
                view: "private",
                reason: "placement",
            });
            return assignment.userId;
        });
        if (unfiledOwner && unfiledOwner !== input.userId)
            await notifyPersonShareChanged(unfiledOwner);
        nudge();
        await scheduleFolderExportProjection(input.userId);
        return;
    }

    const canCurate = await userCuratesOrganizationNow(input.userId);
    await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            await lockOrgTree(tx);
            const currentTarget = await resolveFilingFolder(
                input.userId,
                input.folderId,
                tx,
                canCurate,
            );
            const [placement] = await tx
                .select({ withheld: recordingFolderAssignments.withheld })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(
                            recordingFolderAssignments.folderId,
                            currentTarget.folder.id,
                        ),
                    ),
                );
            if (!placement) return;
            if (currentTarget.folder.restrictingAt)
                await requireOwnedRecording(
                    tx,
                    input.userId,
                    input.recordingId,
                );
            if (placement.withheld) {
                await requireOwnedRecording(
                    tx,
                    input.userId,
                    input.recordingId,
                );
                await lockItemForFolderMutation(
                    tx,
                    input.recordingId,
                    input.userId,
                );
                await notifyRestrictedAudienceInTx(tx, currentTarget.folder.id);
                await tx
                    .delete(mailPendingShares)
                    .where(
                        and(
                            eq(mailPendingShares.userId, input.userId),
                            eq(mailPendingShares.itemId, input.recordingId),
                            eq(
                                mailPendingShares.folderId,
                                currentTarget.folder.id,
                            ),
                        ),
                    );
                await tx
                    .delete(recordingFolderAssignments)
                    .where(
                        and(
                            eq(recordingFolderAssignments.userId, input.userId),
                            eq(
                                recordingFolderAssignments.itemId,
                                input.recordingId,
                            ),
                            eq(
                                recordingFolderAssignments.folderId,
                                currentTarget.folder.id,
                            ),
                        ),
                    );
                await dropReleasedAudienceInTx(tx, currentTarget.folder.id);
                await requestAdvanceInTx(tx, {
                    itemId: input.recordingId,
                    userId: input.userId,
                    view: "private",
                    reason: "placement",
                });
                return;
            }
            await requireMayWithdraw(
                input.userId,
                input.recordingId,
                orgUserId,
                tx,
            );
            await lockItemTaskGraphForFolderMutation(tx, input.recordingId);
            await lockItemForFolderMutation(tx, input.recordingId);
            // Not shared (any more): nothing to take out, and nothing withdrawn.
            // To the organization account it is then a recording it cannot see.
            if (
                !(await isRecordingShared(
                    input.recordingId,
                    target.ownerId,
                    tx,
                ))
            ) {
                if (input.userId === orgUserId) throw notSharedForCurator();
                return;
            }
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(recordingFolderAssignments.folderId, input.folderId),
                    ),
                );
            // Its last Organization folder: leaving it withdraws the recording,
            // which whoever removes it confirms knowing what the owner's
            // retention will then delete. A client that thought another folder remained learns it
            // here, and nothing changed.
            if (
                !input.withdraw &&
                !(await isRecordingShared(
                    input.recordingId,
                    target.ownerId,
                    tx,
                ))
            ) {
                throw new AppError(
                    ErrorCode.WITHDRAW_UNCONFIRMED,
                    "This is the recording's last Organization folder; removing it takes the recording out of the Organization",
                    409,
                );
            }
            await bumpScopeInTx(
                tx,
                await endSharingIfUnfiled(
                    tx,
                    target.ownerId,
                    input.recordingId,
                    input.userId,
                ),
            );
            const [owner] = await tx
                .select({ userId: chatterItems.userId })
                .from(chatterItems)
                .where(eq(chatterItems.id, input.recordingId))
                .limit(1);
            if (owner) {
                if (
                    await isRecordingShared(
                        input.recordingId,
                        target.ownerId,
                        tx,
                    )
                ) {
                    await bindPlacementProfileInTx(tx, {
                        itemId: input.recordingId,
                        ownerUserId: owner.userId,
                        orgUserId: target.ownerId,
                    });
                }
                await requestAdvanceInTx(tx, {
                    itemId: input.recordingId,
                    userId: owner.userId,
                    view: "private",
                    reason: "placement",
                });
            }
        }),
    );
    nudge();
    await orgTreeChanged();
}

/**
 * Remove a recording from the whole Organization tree: its owner, or the
 * organization account (a withdrawal from the Organization's side). Like
 * removing its last Organization folder, it needs `withdraw` (409
 * WITHDRAW_UNCONFIRMED otherwise), sent once the owner's retention warning
 * was seen: an API client is asked as the app is.
 */
export async function unshareRecording(
    userId: string,
    recordingId: string,
    { withdraw = false }: { withdraw?: boolean } = {},
): Promise<void> {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return;
    await requireMayWithdraw(userId, recordingId, orgUserId);
    const withdrew = await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            await lockOrgTree(tx);
            await lockItemTaskGraphForFolderMutation(tx, recordingId);
            await lockItemForFolderMutation(tx, recordingId);
            // Not shared (any more): nothing to withdraw.
            if (!(await isRecordingShared(recordingId, orgUserId, tx))) {
                if (userId === orgUserId) throw notSharedForCurator();
                return false;
            }
            if (!withdraw) {
                throw new AppError(
                    ErrorCode.WITHDRAW_UNCONFIRMED,
                    "Taking the recording out of the Organization needs withdraw: true, sent once the owner's retention warning was seen",
                    409,
                );
            }
            await bumpScopeInTx(
                tx,
                await withdrawRecordingInTx(tx, orgUserId, recordingId, userId),
            );
            const [owner] = await tx
                .select({ userId: chatterItems.userId })
                .from(chatterItems)
                .where(eq(chatterItems.id, recordingId))
                .limit(1);
            if (owner) {
                await requestAdvanceInTx(tx, {
                    itemId: recordingId,
                    userId: owner.userId,
                    view: "private",
                    reason: "placement",
                });
            }
            return true;
        }),
    );
    if (withdrew) {
        nudge();
        await orgTreeChanged();
    }
}

/**
 * Take a recording out of the whole Organization tree in the caller's
 * transaction, which holds the Organization tree lock and then the
 * recording's. The caller checked the owner, and calls `orgTreeChanged`
 * after it commits.
 */
export async function withdrawRecordingInTx(
    tx: Tx,
    orgUserId: string,
    recordingId: string,
    actorUserId: string,
): Promise<Set<string>> {
    const orgFolderIds = (
        await tx
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.userId, orgUserId))
    ).map((row) => row.id);
    if (orgFolderIds.length > 0) {
        await tx
            .delete(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.itemId, recordingId),
                    inArray(recordingFolderAssignments.folderId, orgFolderIds),
                    eq(recordingFolderAssignments.withheld, false),
                ),
            );
    }
    return endSharingIfUnfiled(tx, orgUserId, recordingId, actorUserId);
}

/**
 * Taking a recording out of Organization folders, down to withdrawing it:
 * its owner, or the organization account, which decides what the
 * Organization holds (maintainer, 2026-09-28). Sharing stays the owner's.
 */
async function requireMayWithdraw(
    userId: string,
    recordingId: string,
    orgUserId: string | null,
    executor: Pick<typeof db, "select"> = db,
): Promise<void> {
    if (orgUserId !== null && userId === orgUserId) {
        // Only a recording it can see: one that is shared now. Checked again
        // under the locks.
        const [recording] = await executor
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, recordingId),
                    isNull(chatterItems.deletedAt),
                ),
            )
            .limit(1);
        if (
            !recording ||
            !(await isRecordingShared(recordingId, orgUserId, executor))
        ) {
            throw notSharedForCurator();
        }
        return;
    }
    await requireRecordingOwnerForSharing(userId, recordingId, executor);
}

/** A recording that is not shared, as the organization account sees it. */
function notSharedForCurator(): AppError {
    return new AppError(
        ErrorCode.NOT_FOUND,
        "Recording or folder not found",
        404,
    );
}

async function requireRecordingOwnerForSharing(
    userId: string,
    recordingId: string,
    executor: Pick<typeof db, "select"> = db,
): Promise<void> {
    const [recording] = await executor
        .select({ userId: chatterItems.userId })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                isNull(chatterItems.deletedAt),
            ),
        )
        .limit(1);
    if (!recording) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "Recording or folder not found",
            404,
        );
    }
    if (recording.userId !== userId) {
        throw new AppError(
            ErrorCode.FORBIDDEN,
            "Only the recording's owner can remove it from the Organization",
            403,
        );
    }
}

/**
 * End the sharing of a recording that has left the last Organization folder.
 *
 * A shared recording is one recording, and its owner gets it back as the
 * Organization left it: every transcript, name and summary stays, and so
 * do the corrections, now the owner's (`withdrawKnowledgeInTx`); the
 * Organization's evidence goes. What the organization account queued on
 * it is cancelled, as it may change the recording no longer.
 *
 * Returns the knowledge scopes the withdrawal reached, for the caller to
 * bump at its end; none when the recording is still filed.
 */
export async function endSharingIfUnfiled(
    tx: Tx,
    orgUserId: string,
    recordingId: string,
    actorUserId: string,
): Promise<Set<string>> {
    const remaining = await tx
        .select({ folderId: recordingFolderAssignments.folderId })
        .from(recordingFolderAssignments)
        .innerJoin(
            recordingFolders,
            eq(recordingFolders.id, recordingFolderAssignments.folderId),
        )
        .where(
            and(
                eq(recordingFolderAssignments.itemId, recordingId),
                eq(recordingFolders.userId, orgUserId),
                eq(recordingFolderAssignments.withheld, false),
                isNull(recordingFolders.restrictedAt),
            ),
        )
        .limit(1);
    if (remaining.length > 0) return new Set();

    const [owner] = await tx
        .select({ userId: chatterItems.userId })
        .from(chatterItems)
        .where(eq(chatterItems.id, recordingId))
        .limit(1);
    if (!owner) return new Set();
    await lockPlacementProfilesInTx(tx, recordingId, owner.userId, orgUserId);
    const now = new Date();
    await tx
        .update(asyncJobs)
        .set({
            status: "failed",
            completedAt: now,
            updatedAt: now,
            heartbeatAt: null,
            claimToken: null,
            errorCode: ErrorCode.RECORDING_NOT_FOUND,
            lastError: "Cancelled because the recording is no longer shared",
        })
        .where(
            and(
                eq(
                    asyncJobs.subjectId,
                    recordingJobSubject(recordingId, "org"),
                ),
                inArray(asyncJobs.status, ["pending", "processing"]),
            ),
        );

    await bindPlacementProfileInTx(tx, {
        itemId: recordingId,
        ownerUserId: owner.userId,
        orgUserId,
    });
    await withdrawItemTaskHomesInTx(tx, {
        itemId: recordingId,
        ownerUserId: owner.userId,
        actorUserId,
        orgUserId,
    });
    return withdrawKnowledgeInTx(tx, {
        recordingId,
        ownerUserId: owner.userId,
        orgUserId,
    });
}

/**
 * Move a shared recording from one Organization folder to another.
 *
 * Open to every account: filing within the tree is collaborative, sharing
 * and unsharing are not. One transaction, so the recording is never briefly
 * unshared in between.
 */
export async function moveRecordingBetweenFolders(input: {
    userId: string;
    recordingId: string;
    fromFolderId: string;
    toFolderId: string;
    withdraw?: boolean;
}): Promise<void> {
    const orgUserId = await getOrgUserId();
    const canCurate = await userCuratesOrganizationNow(input.userId);
    await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            if (orgUserId) await lockOrgTree(tx);
            const from = await resolveFilingFolder(
                input.userId,
                input.fromFolderId,
                tx,
                canCurate,
            );
            const to = await resolveFilingFolder(
                input.userId,
                input.toFolderId,
                tx,
                canCurate,
            );
            assertWritable(from);
            assertWritable(to);
            if (to.folder.kind === "private")
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Every recording already appears in Private",
                    400,
                );
            if (from.folder.id === to.folder.id) return;
            const [source] = await tx
                .select({
                    userId: recordingFolderAssignments.userId,
                    withheld: recordingFolderAssignments.withheld,
                })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(recordingFolderAssignments.folderId, from.folder.id),
                    ),
                );
            if (!source) throw folderNotFound();
            const boundary = !!(
                source.withheld ||
                from.folder.restrictedAt ||
                from.folder.restrictingAt ||
                to.folder.restrictedAt ||
                to.folder.restrictingAt
            );
            const ownerOnly =
                boundary ||
                from.scope !== to.scope ||
                from.scope === "personal";
            if (ownerOnly)
                await requireOwnedRecording(
                    tx,
                    input.userId,
                    input.recordingId,
                );
            const organizationId = orgUserIdForMove(from, to);
            if (organizationId) {
                await lockOrgPeople(tx);
                await lockItemTaskGraphForFolderMutation(tx, input.recordingId);
            }
            for (const target of [from, to]
                .filter((target) => target.scope === "personal")
                .sort((a, b) => a.folder.id.localeCompare(b.folder.id)))
                await lockCategorizableFolderInTx(
                    tx,
                    input.userId,
                    target.folder.id,
                    true,
                );
            await lockItemForFolderMutation(
                tx,
                input.recordingId,
                source.userId,
            );
            if (ownerOnly)
                await requireOwnedRecording(
                    tx,
                    input.userId,
                    input.recordingId,
                );
            const wasShared = organizationId
                ? await isRecordingShared(input.recordingId, organizationId, tx)
                : false;
            if (
                from.scope === "org" &&
                (to.folder.restrictedAt || to.folder.restrictingAt)
            )
                await revokePlacementExportsInTx(
                    tx,
                    from.ownerId,
                    input.recordingId,
                    from.folder.id,
                );
            if (to.scope === "org" && (boundary || from.scope !== to.scope)) {
                const problems = await shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId: input.userId,
                    itemId: input.recordingId,
                    folderId: to.folder.id,
                    orgUserId: to.ownerId,
                    canReadRestricted: canCurate,
                });
                if (problems.length)
                    throw new AppError(
                        ErrorCode.SHARE_REQUIREMENTS_UNMET,
                        ErrorCode.SHARE_REQUIREMENTS_UNMET,
                        409,
                        { problems },
                    );
            } else {
                const releasedAt =
                    to.scope === "org"
                        ? await placementReleaseTimeInTx(
                              tx,
                              source.userId,
                              input.recordingId,
                              to.ownerId,
                          )
                        : null;
                await tx
                    .insert(recordingFolderAssignments)
                    .values({
                        userId: source.userId,
                        itemId: input.recordingId,
                        folderId: to.folder.id,
                        releasedAt,
                    })
                    .onConflictDoNothing();
            }
            await notifyRestrictedAudienceInTx(tx, from.folder.id);
            await notifyFolderReceiversInTx(
                tx,
                source.userId,
                input.recordingId,
                from.folder.id,
            );
            if (source.withheld)
                await tx
                    .delete(mailPendingShares)
                    .where(
                        and(
                            eq(mailPendingShares.userId, source.userId),
                            eq(mailPendingShares.itemId, input.recordingId),
                            eq(mailPendingShares.folderId, from.folder.id),
                        ),
                    );
            await tx
                .delete(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.userId, source.userId),
                        eq(
                            recordingFolderAssignments.itemId,
                            input.recordingId,
                        ),
                        eq(recordingFolderAssignments.folderId, from.folder.id),
                    ),
                );
            await dropReleasedAudienceInTx(tx, from.folder.id);
            if (wasShared && organizationId) {
                if (
                    !boundary &&
                    !input.withdraw &&
                    !(await isRecordingShared(
                        input.recordingId,
                        organizationId,
                        tx,
                    ))
                )
                    throw new AppError(
                        ErrorCode.WITHDRAW_UNCONFIRMED,
                        "Removing the last Organization placement needs withdraw: true",
                        409,
                    );
                await bumpScopeInTx(
                    tx,
                    await endSharingIfUnfiled(
                        tx,
                        organizationId,
                        input.recordingId,
                        input.userId,
                    ),
                );
            }
            await notifyFolderReceiversInTx(
                tx,
                source.userId,
                input.recordingId,
                to.folder.id,
            );
            await pruneRedundantAssignmentsInTx(
                tx,
                to.ownerId,
                input.recordingId,
            );
            if (to.scope === "org" && wasShared)
                await bindPlacementProfileInTx(tx, {
                    itemId: input.recordingId,
                    ownerUserId: source.userId,
                    orgUserId: to.ownerId,
                });
            await requestAdvanceInTx(tx, {
                itemId: input.recordingId,
                userId: source.userId,
                view: from.scope === "org" && !ownerOnly ? "org" : "private",
                reason: "placement",
            });
        }),
    );
    nudge();
    if (orgUserId) await orgTreeChanged();
    await scheduleFolderExportProjection(input.userId);
}

/**
 * Retire the per-user Public roots of a self-host instance.
 *
 * They were never shared with anyone. Empty ones are deleted; any with
 * content become a "Former Public" folder in their owner's Private tree, so
 * the upgrade shares nothing on its own. Idempotent.
 */
export async function retireLegacyPublicRoots(tx: Tx): Promise<number> {
    const legacyRoots = await tx
        .select(folderColumns)
        .from(recordingFolders)
        .innerJoin(users, eq(users.id, recordingFolders.userId))
        .where(
            and(
                eq(recordingFolders.kind, "public"),
                isNull(recordingFolders.parentId),
                ne(users.role, "org"),
            ),
        );
    let retired = 0;
    for (const root of legacyRoots) {
        const folders = await listTreeFolders(tx, root.userId);
        const subtree = [...subtreeIds(folders, root.id)];
        const [child] = folders.filter((folder) => folder.parentId === root.id);
        const [assignment] = await tx
            .select({ recordingId: recordingFolderAssignments.itemId })
            .from(recordingFolderAssignments)
            .where(inArray(recordingFolderAssignments.folderId, subtree))
            .limit(1);
        if (!child && !assignment) {
            await tx
                .delete(recordingFolders)
                .where(eq(recordingFolders.id, root.id));
            retired += 1;
            continue;
        }

        await insertRoots(tx, root.userId, [PRIVATE_ROOT]);
        const [privateRoot] = await tx
            .select(folderColumns)
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.userId, root.userId),
                    eq(recordingFolders.kind, "private"),
                    isNull(recordingFolders.parentId),
                ),
            )
            .limit(1);
        if (!privateRoot) continue;
        const siblings = folders.filter(
            (folder) => folder.parentId === privateRoot.id,
        );
        const takenNames = new Set(
            siblings.map((folder) => decryptText(folder.name)),
        );
        let name = "Former Public";
        for (let suffix = 2; takenNames.has(name); suffix += 1) {
            name = `Former Public ${suffix}`;
        }
        const sortOrder =
            siblings.reduce(
                (highest, sibling) => Math.max(highest, sibling.sortOrder),
                -FOLDER_ORDER_STEP,
            ) + FOLDER_ORDER_STEP;
        await tx
            .update(recordingFolders)
            .set({
                kind: "custom",
                parentId: privateRoot.id,
                name: encryptText(name),
                nameHash: lookupHash(name),
                sortOrder,
                updatedAt: new Date(),
            })
            .where(eq(recordingFolders.id, root.id));
        retired += 1;
    }
    return retired;
}

function orgUserIdForMove(from: AccessibleFolder, to: AccessibleFolder) {
    return from.scope === "org"
        ? from.ownerId
        : to.scope === "org"
          ? to.ownerId
          : "";
}
