import { and, eq, exists, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    approvePendingFolderRequests,
    cancelFolderRequests,
} from "@/db/queries/restricted-folder-access-requests";
import {
    dropReleasedAudienceInTx,
    notifyRestrictedAudienceInTx,
    placementVisibleCondition,
    restrictedItemCondition,
    restrictedMemberCondition,
    revokePlacementExportsInTx,
    withheldItemCondition,
} from "@/db/queries/restricted-folders";
import { retentionPolicyOf } from "@/db/queries/retention";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import {
    almanacShareChanges,
    almanacShareEvents,
    asyncJobs,
    chatterItems,
    folderExportConfigurations,
    mailMessages,
    mailPendingShares,
    recordingFolderAssignments,
    recordingFolders,
    restrictedFolderMembers,
    userSettings,
    users,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { retryOnDeadlock } from "@/lib/deadlock-retry";
import { AppError, ErrorCode } from "@/lib/errors";
import {
    notifyRestrictedAccessDecision,
    restrictedAudienceAuthorityInTx,
} from "@/lib/folders/access-requests";
import {
    endSharingIfUnfiled,
    lockItemForFolderMutation,
    lockOrgTree,
    orgTreeChanged,
    resolveReadableFolder,
    shareItemToOrganizationFolderInTx,
} from "@/lib/folders/folders";
import {
    creatorMayRestrictFolder,
    initializeRestrictedAudienceInTx,
    validateRestrictedAudience,
} from "@/lib/folders/restriction";
import { nudge } from "@/lib/jobs/nudge";
import { lockOrgPeople } from "@/lib/knowledge/org-people";
import { bumpScopeInTx } from "@/lib/knowledge/scope-generation";
import { mailShareProblems } from "@/lib/mail/share-gate";
import { assertOrgScopeWritable, getOrgUserId } from "@/lib/org/config";
import { requestAdvanceInTx } from "@/lib/pipeline/trigger";
import { loadShareGate } from "@/lib/sharing/load-share-gate";
import { sharedItemCondition } from "@/lib/sharing/shared";
import { lockItemTaskGraphInTx } from "@/lib/tasks/mentions";

export const RESTRICTED_FOLDER_JOB_KIND = "folder.restriction";
export const RESTRICTED_FOLDER_REQUEST_LIMIT = 25;

async function requireAudienceAccess(
    userId: string,
    folderId: string,
    manage = false,
    curatorOnly = false,
) {
    const isCurator = await userCuratesOrganizationNow(userId);
    const folder = await resolveReadableFolder(userId, folderId);
    if (!folder || folder.scope !== "org" || folder.folder.kind !== "custom")
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    const [member] = await db
        .select()
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
        );
    if (
        (!isCurator && !member) ||
        (curatorOnly && !isCurator) ||
        (manage && !isCurator && member?.role !== "manager")
    )
        throw new AppError(
            curatorOnly || manage ? ErrorCode.FORBIDDEN : ErrorCode.NOT_FOUND,
            curatorOnly || manage ? ErrorCode.FORBIDDEN : ErrorCode.NOT_FOUND,
            curatorOnly || manage ? 403 : 404,
        );
    return {
        ...folder,
        isCurator,
        role: isCurator
            ? ("curator" as const)
            : (member?.role ?? ("member" as const)),
    };
}

/** Current audience and which people own direct contents, for removal confirmation. */
export async function listRestrictedAudience(userId: string, folderId: string) {
    const access = await requireAudienceAccess(userId, folderId);
    const members = await db
        .select({
            userId: users.id,
            name: users.name,
            email: users.email,
            role: restrictedFolderMembers.role,
            ownsItems: exists(
                db
                    .select({ id: recordingFolderAssignments.itemId })
                    .from(recordingFolderAssignments)
                    .innerJoin(
                        chatterItems,
                        and(
                            eq(
                                chatterItems.id,
                                recordingFolderAssignments.itemId,
                            ),
                            eq(
                                chatterItems.userId,
                                recordingFolderAssignments.userId,
                            ),
                        ),
                    )
                    .where(
                        and(
                            eq(recordingFolderAssignments.folderId, folderId),
                            eq(recordingFolderAssignments.userId, users.id),
                            isNull(chatterItems.deletedAt),
                        ),
                    ),
            ).mapWith(Boolean),
        })
        .from(restrictedFolderMembers)
        .innerJoin(users, eq(users.id, restrictedFolderMembers.userId))
        .where(
            and(
                eq(restrictedFolderMembers.folderId, folderId),
                activeShareRecipientCondition(),
            ),
        );
    return { members, role: access.role, curatorsCanRead: true as const };
}

/** Audience members add people; managers and curators remove anyone without unfiling items. */
export async function changeRestrictedAudience(
    userId: string,
    folderId: string,
    input: { addUserIds?: string[]; removeUserId?: string },
) {
    const access = await requireAudienceAccess(
        userId,
        folderId,
        !!input.removeUserId,
    );
    assertOrgScopeWritable();
    const ids = await validateRestrictedAudience(input.addUserIds ?? []);
    const result = await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        const [folder] = await tx
            .select({
                restrictedAt: recordingFolders.restrictedAt,
                restrictingAt: recordingFolders.restrictingAt,
            })
            .from(recordingFolders)
            .where(eq(recordingFolders.id, folderId))
            .for("update");
        if (!folder)
            throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
        await restrictedAudienceAuthorityInTx(
            tx,
            userId,
            folderId,
            access.isCurator,
            !!input.removeUserId,
        );
        if (input.removeUserId) {
            await notifyRestrictedAudienceInTx(tx, folderId);
            await tx
                .delete(restrictedFolderMembers)
                .where(
                    and(
                        eq(restrictedFolderMembers.folderId, folderId),
                        eq(restrictedFolderMembers.userId, input.removeUserId),
                    ),
                );
        }
        const recipients = ids.length
            ? await tx
                  .select({ id: users.id })
                  .from(users)
                  .where(
                      and(
                          inArray(users.id, ids),
                          activeShareRecipientCondition(),
                      ),
                  )
            : [];
        const eligible = recipients.map((recipient) => recipient.id);
        if (eligible.length)
            await tx
                .insert(restrictedFolderMembers)
                .values(
                    eligible.map((id) => ({
                        folderId,
                        userId: id,
                        addedByUserId: userId,
                    })),
                )
                .onConflictDoNothing();
        await notifyRestrictedAudienceInTx(tx, folderId);
        return {
            approved: await approvePendingFolderRequests(
                tx,
                folderId,
                eligible,
                userId,
            ),
            addedUserIds: eligible,
            skippedUserIds: ids.filter((id) => !eligible.includes(id)),
        };
    });
    await Promise.all(
        result.approved.map((request) =>
            notifyRestrictedAccessDecision(request.userId, "approved"),
        ),
    );
    return {
        addedUserIds: result.addedUserIds,
        skippedUserIds: result.skippedUserIds,
    };
}

async function folderItems(folderId: string) {
    return db
        .select({
            id: chatterItems.id,
            kind: chatterItems.kind,
            ownerUserId: chatterItems.userId,
            ownerName: users.name,
            ownerEmail: users.email,
            occurredAt: chatterItems.occurredAt,
            receivedAt: mailMessages.receivedAt,
            withheld: recordingFolderAssignments.withheld,
        })
        .from(recordingFolderAssignments)
        .innerJoin(
            chatterItems,
            and(
                eq(chatterItems.id, recordingFolderAssignments.itemId),
                eq(chatterItems.userId, recordingFolderAssignments.userId),
            ),
        )
        .innerJoin(users, eq(users.id, chatterItems.userId))
        .leftJoin(
            mailMessages,
            and(
                eq(mailMessages.id, chatterItems.id),
                eq(mailMessages.userId, chatterItems.userId),
            ),
        )
        .where(
            and(
                eq(recordingFolderAssignments.folderId, folderId),
                isNull(chatterItems.deletedAt),
            ),
        );
}

async function requireRestrictionAccess(userId: string, folderId: string) {
    const isCurator = await userCuratesOrganizationNow(userId);
    const folder = await resolveReadableFolder(userId, folderId);
    if (!folder || folder.scope !== "org" || folder.folder.kind !== "custom")
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    if (!isCurator && !(await creatorMayRestrictFolder(userId, folderId)))
        throw new AppError(ErrorCode.FORBIDDEN, ErrorCode.FORBIDDEN, 403);
    return { ...folder, isCurator };
}

/** Preview the withdrawal and permanent Almanac additions before restricting an open folder. */
export async function previewFolderRestriction(
    userId: string,
    folderId: string,
) {
    const folder = await requireRestrictionAccess(userId, folderId);
    const items = await folderItems(folderId);
    const otherOpen = items.length
        ? await db
              .select({ itemId: recordingFolderAssignments.itemId })
              .from(recordingFolderAssignments)
              .innerJoin(
                  recordingFolders,
                  eq(recordingFolders.id, recordingFolderAssignments.folderId),
              )
              .where(
                  and(
                      inArray(
                          recordingFolderAssignments.itemId,
                          items.map((item) => item.id),
                      ),
                      ne(recordingFolders.id, folderId),
                      eq(recordingFolders.userId, folder.ownerId),
                      isNull(recordingFolders.restrictedAt),
                      eq(recordingFolderAssignments.withheld, false),
                  ),
              )
        : [];
    const remainsShared = new Set(otherOpen.map((item) => item.itemId));
    const additions = items.length
        ? await db
              .select({
                  itemId: almanacShareEvents.itemId,
                  eventId: almanacShareEvents.id,
                  kind: almanacShareChanges.kind,
                  targetId: almanacShareChanges.targetId,
              })
              .from(almanacShareEvents)
              .innerJoin(
                  almanacShareChanges,
                  eq(almanacShareChanges.eventId, almanacShareEvents.id),
              )
              .where(
                  and(
                      eq(almanacShareEvents.userId, folder.ownerId),
                      inArray(
                          almanacShareEvents.itemId,
                          items.map((item) => item.id),
                      ),
                      eq(almanacShareChanges.added, true),
                      inArray(almanacShareChanges.kind, ["person", "entity"]),
                      isNull(almanacShareChanges.removedAt),
                  ),
              )
        : [];
    const tree = await db
        .select({
            id: recordingFolders.id,
            parentId: recordingFolders.parentId,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.userId, folder.ownerId));
    const ancestors = new Set([folderId]);
    let current = tree.find((row) => row.id === folderId);
    while (current?.parentId && !ancestors.has(current.parentId)) {
        ancestors.add(current.parentId);
        current = tree.find((row) => row.id === current?.parentId);
    }
    const exports = await db
        .select({
            id: folderExportConfigurations.id,
            folderId: folderExportConfigurations.folderId,
            writerUserId: folderExportConfigurations.userId,
            provider: folderExportConfigurations.provider,
        })
        .from(folderExportConfigurations)
        .where(inArray(folderExportConfigurations.folderId, [...ancestors]));
    const counts = new Map<
        string,
        { kind: string; ownerUserId: string; count: number }
    >();
    for (const item of items) {
        const key = `${item.kind}:${item.ownerUserId}`;
        const count = counts.get(key) ?? {
            kind: item.kind,
            ownerUserId: item.ownerUserId,
            count: 0,
        };
        count.count++;
        counts.set(key, count);
    }
    return {
        counts: [...counts.values()],
        audience: folder.folder.restrictingAt
            ? await db
                  .select({
                      id: users.id,
                      name: users.name,
                      email: users.email,
                  })
                  .from(restrictedFolderMembers)
                  .innerJoin(
                      users,
                      eq(users.id, restrictedFolderMembers.userId),
                  )
                  .where(
                      and(
                          eq(restrictedFolderMembers.folderId, folderId),
                          activeShareRecipientCondition(),
                      ),
                  )
            : [],
        items,
        withdrawnItems: items.filter((item) => !remainsShared.has(item.id)),
        retainedAlmanacAdditions: additions,
        provenanceComplete: false,
        exports,
    };
}

/** Gate and retention preview for opening a restricted folder without further approval. */
export async function previewFolderLift(userId: string, folderId: string) {
    const access = await requireAudienceAccess(userId, folderId, true);
    const items = await folderItems(folderId);
    const [settings] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, access.ownerId));
    const audioPolicy = settings ? retentionPolicyOf(settings) : null;
    const graceEndsAt = new Date(Date.now() + 30 * 86400000).toISOString();
    const previews = [];
    for (const item of items) {
        const problems = await db.transaction((tx) =>
            item.kind === "audio"
                ? loadShareGate(tx, item.id, item.ownerUserId)
                : item.kind === "mail"
                  ? mailShareProblems(tx, item.id, item.ownerUserId)
                  : Promise.resolve([]),
        );
        const days =
            item.kind === "mail"
                ? [
                      settings?.retentionMailRawDays,
                      settings?.retentionMailContentDays,
                      settings?.retentionMailSummaryDays,
                  ]
                : [
                      audioPolicy?.audioDays,
                      audioPolicy?.transcriptDays,
                      audioPolicy?.summaryDays,
                  ];
        previews.push({
            ...item,
            problems,
            graceEndsAt,
            reachedByOrganizationRetention: days.some(
                (day) =>
                    day !== null &&
                    day !== undefined &&
                    (item.kind === "mail"
                        ? (item.receivedAt ?? item.occurredAt)
                        : item.occurredAt
                    ).getTime() +
                        day * 86400000 <=
                        Date.parse(graceEndsAt),
            ),
        });
    }
    return {
        items: previews,
        sharedNow: previews.filter((item) => !item.problems.length),
        pending: previews.filter((item) => item.problems.length),
        graceEndsAt,
    };
}

export interface RestrictedFolderItemWork {
    folderId: string;
    itemId: string;
    ownerUserId: string;
    operation: "restrict" | "lift";
    restriction: string;
}

async function finishRestrictionInTx(
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    folderId: string,
    epoch: Date | null,
) {
    if (!epoch) return;
    const [remaining] = await tx
        .select({ id: recordingFolderAssignments.itemId })
        .from(recordingFolderAssignments)
        .where(
            and(
                eq(recordingFolderAssignments.folderId, folderId),
                eq(recordingFolderAssignments.withheld, false),
            ),
        )
        .limit(1);
    if (!remaining)
        await tx
            .update(recordingFolders)
            .set({
                restrictedAt: epoch,
                restrictingAt: null,
                updatedAt: new Date(),
                version: sql`${recordingFolders.version} + 1`,
            })
            .where(
                and(
                    eq(recordingFolders.id, folderId),
                    eq(recordingFolders.restrictingAt, epoch),
                ),
            );
}

/** Each transition takes tree, people, task graph, item, processing and profile locks in order. */
export async function processRestrictedFolderItem(
    work: RestrictedFolderItemWork,
) {
    const orgUserId = await getOrgUserId();
    if (!orgUserId) return;
    await retryOnDeadlock(() =>
        db.transaction(async (tx) => {
            await lockOrgTree(tx);
            await lockOrgPeople(tx);
            const [folder] = await tx
                .select({
                    restrictedAt: recordingFolders.restrictedAt,
                    restrictingAt: recordingFolders.restrictingAt,
                })
                .from(recordingFolders)
                .where(
                    and(
                        eq(recordingFolders.id, work.folderId),
                        eq(recordingFolders.userId, orgUserId),
                    ),
                );
            if (
                !folder ||
                (work.operation === "restrict"
                    ? folder.restrictingAt?.toISOString() !== work.restriction
                    : !!folder.restrictedAt || !!folder.restrictingAt)
            )
                return;
            const [assignment] = await tx
                .select({ withheld: recordingFolderAssignments.withheld })
                .from(recordingFolderAssignments)
                .where(
                    and(
                        eq(recordingFolderAssignments.folderId, work.folderId),
                        eq(recordingFolderAssignments.itemId, work.itemId),
                        eq(recordingFolderAssignments.userId, work.ownerUserId),
                    ),
                );
            if (
                !assignment ||
                (work.operation === "lift" && !assignment.withheld) ||
                (work.operation === "restrict" && assignment.withheld)
            ) {
                if (work.operation === "restrict")
                    await finishRestrictionInTx(
                        tx,
                        work.folderId,
                        folder.restrictingAt,
                    );
                return;
            }
            await lockItemTaskGraphInTx(tx, {
                itemId: work.itemId,
                ownerUserId: work.ownerUserId,
            });
            await lockItemForFolderMutation(tx, work.itemId, work.ownerUserId);
            if (work.operation === "restrict") {
                await revokePlacementExportsInTx(
                    tx,
                    orgUserId,
                    work.itemId,
                    work.folderId,
                );
                await tx
                    .update(recordingFolderAssignments)
                    .set({ withheld: true, releasedAt: null })
                    .where(
                        and(
                            eq(
                                recordingFolderAssignments.folderId,
                                work.folderId,
                            ),
                            eq(recordingFolderAssignments.itemId, work.itemId),
                            eq(
                                recordingFolderAssignments.userId,
                                work.ownerUserId,
                            ),
                        ),
                    );
            }
            await bumpScopeInTx(
                tx,
                await endSharingIfUnfiled(
                    tx,
                    orgUserId,
                    work.itemId,
                    work.ownerUserId,
                ),
            );
            if (work.operation === "lift") {
                const problems = await shareItemToOrganizationFolderInTx(tx, {
                    ownerUserId: work.ownerUserId,
                    itemId: work.itemId,
                    folderId: work.folderId,
                    orgUserId,
                });
                if (!problems.length)
                    await tx
                        .delete(mailPendingShares)
                        .where(
                            and(
                                eq(mailPendingShares.userId, work.ownerUserId),
                                eq(mailPendingShares.itemId, work.itemId),
                                eq(mailPendingShares.folderId, work.folderId),
                            ),
                        );
                if (problems.length)
                    await tx
                        .insert(mailPendingShares)
                        .values({
                            userId: work.ownerUserId,
                            itemId: work.itemId,
                            folderId: work.folderId,
                            confirmedAt: new Date(),
                        })
                        .onConflictDoNothing();
            }
            await requestAdvanceInTx(tx, {
                userId: work.ownerUserId,
                itemId: work.itemId,
                view: "private",
                reason: "placement",
            });
            if (work.operation === "restrict")
                await finishRestrictionInTx(
                    tx,
                    work.folderId,
                    folder.restrictingAt,
                );
            await notifyRestrictedAudienceInTx(tx, work.folderId);
        }),
    );
    await orgTreeChanged(work.folderId, { structural: true });
}

/** Restrict or lift with durable per-item recovery and at most 25 immediate item transactions. */
export async function changeFolderRestriction(
    userId: string,
    folderId: string,
    operation: "restrict" | "lift",
    audienceUserIds: string[] = [],
) {
    const access =
        operation === "lift"
            ? await requireAudienceAccess(userId, folderId, true)
            : await requireRestrictionAccess(userId, folderId);
    assertOrgScopeWritable();
    const audience = await validateRestrictedAudience(audienceUserIds);
    const orgUserId = access?.ownerId ?? (await getOrgUserId());
    if (!orgUserId)
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    const work = await db.transaction(async (tx) => {
        await lockOrgTree(tx);
        const [folder] = await tx
            .select()
            .from(recordingFolders)
            .where(
                and(
                    eq(recordingFolders.id, folderId),
                    eq(recordingFolders.userId, orgUserId),
                ),
            )
            .for("update");
        if (!folder)
            throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
        const [child] = await tx
            .select({ id: recordingFolders.id })
            .from(recordingFolders)
            .where(eq(recordingFolders.parentId, folderId))
            .limit(1);
        if (child)
            throw new AppError(
                ErrorCode.RESTRICTED_FOLDER_HAS_CHILDREN,
                ErrorCode.RESTRICTED_FOLDER_HAS_CHILDREN,
                409,
            );
        const creatorMayRestrict =
            operation === "restrict" &&
            (await creatorMayRestrictFolder(userId, folderId, tx));
        if (!creatorMayRestrict)
            await restrictedAudienceAuthorityInTx(
                tx,
                userId,
                folderId,
                access.isCurator,
                true,
                operation === "restrict",
            );
        if (operation === "lift") await cancelFolderRequests(tx, folderId);
        if (operation === "restrict" && folder.restrictedAt) return [];
        const restriction =
            folder.restrictingAt?.toISOString() ??
            folder.restrictedAt?.toISOString() ??
            new Date().toISOString();
        await tx
            .update(recordingFolders)
            .set({
                restrictedAt: null,
                restrictingAt:
                    operation === "restrict" ? new Date(restriction) : null,
                version: sql`${recordingFolders.version} + 1`,
                updatedAt: new Date(),
            })
            .where(eq(recordingFolders.id, folderId));
        if (operation === "restrict") {
            await revokePlacementExportsInTx(tx, orgUserId, null, folderId);
            await notifyRestrictedAudienceInTx(tx, folderId);
            if (!folder.restrictingAt) {
                await tx
                    .delete(restrictedFolderMembers)
                    .where(eq(restrictedFolderMembers.folderId, folderId));
                await initializeRestrictedAudienceInTx(
                    tx,
                    folderId,
                    userId,
                    audience,
                );
            } else if (audience.length) {
                await tx
                    .insert(restrictedFolderMembers)
                    .values(
                        audience.map((id) => ({
                            folderId,
                            userId: id,
                            addedByUserId: userId,
                        })),
                    )
                    .onConflictDoNothing();
            }
            if (creatorMayRestrict)
                await tx
                    .insert(restrictedFolderMembers)
                    .values({
                        folderId,
                        userId,
                        role: "manager",
                        addedByUserId: userId,
                    })
                    .onConflictDoUpdate({
                        target: [
                            restrictedFolderMembers.folderId,
                            restrictedFolderMembers.userId,
                        ],
                        set: { role: "manager" },
                    });
            const owners = await tx
                .selectDistinct({ userId: recordingFolderAssignments.userId })
                .from(recordingFolderAssignments)
                .where(eq(recordingFolderAssignments.folderId, folderId));
            if (owners.length)
                await tx
                    .insert(restrictedFolderMembers)
                    .values(
                        owners.map((owner) => ({
                            folderId,
                            userId: owner.userId,
                            addedByUserId: userId,
                        })),
                    )
                    .onConflictDoNothing();
            await tx
                .delete(mailPendingShares)
                .where(eq(mailPendingShares.folderId, folderId));
        }
        const items = await tx
            .select({
                itemId: recordingFolderAssignments.itemId,
                ownerUserId: recordingFolderAssignments.userId,
            })
            .from(recordingFolderAssignments)
            .where(
                and(
                    eq(recordingFolderAssignments.folderId, folderId),
                    eq(
                        recordingFolderAssignments.withheld,
                        operation === "lift",
                    ),
                ),
            );
        if (operation === "restrict" && items.length === 0)
            await tx
                .update(recordingFolders)
                .set({
                    restrictedAt: new Date(restriction),
                    restrictingAt: null,
                })
                .where(eq(recordingFolders.id, folderId));
        if (operation === "lift" && items.length === 0)
            await dropReleasedAudienceInTx(tx, folderId);
        const jobs = items.map(
            (item): RestrictedFolderItemWork => ({
                ...item,
                folderId,
                operation,
                restriction,
            }),
        );
        const nextAttemptAt = new Date(Date.now() + 1000);
        for (let offset = 0; offset < jobs.length; offset += 250)
            await tx
                .insert(asyncJobs)
                .values(
                    jobs.slice(offset, offset + 250).map((item) => ({
                        userId: item.ownerUserId,
                        kind: RESTRICTED_FOLDER_JOB_KIND,
                        subjectId: `${folderId}:${item.itemId}:${operation}:${restriction}`,
                        payload: { ...item },
                        nextAttemptAt,
                        maxAttempts: 5,
                    })),
                )
                .onConflictDoNothing();
        await notifyRestrictedAudienceInTx(tx, folderId);
        return jobs;
    });
    for (const item of work.slice(0, RESTRICTED_FOLDER_REQUEST_LIMIT))
        await processRestrictedFolderItem(item);
    nudge();
    await orgTreeChanged(folderId, { structural: true });
    const [state] = await db
        .select({
            restrictedAt: recordingFolders.restrictedAt,
            restrictingAt: recordingFolders.restrictingAt,
        })
        .from(recordingFolders)
        .where(eq(recordingFolders.id, folderId));
    return {
        restricted: !!state?.restrictedAt,
        restricting: !!state?.restrictingAt,
        processed: Math.min(work.length, RESTRICTED_FOLDER_REQUEST_LIMIT),
        queued: Math.max(0, work.length - RESTRICTED_FOLDER_REQUEST_LIMIT),
    };
}

/** A readable item's owner and restricted audience, for assignment warnings. */
export async function restrictedItemReaders(userId: string, itemId: string) {
    const isCurator = await userCuratesOrganizationNow(userId);
    const orgUserId = await getOrgUserId();
    const [item] = await db
        .select({
            ownerUserId: chatterItems.userId,
            restricted: sql<boolean>`${withheldItemCondition()} and (${chatterItems.userId} = ${userId} or ${restrictedItemCondition({ userId, isCurator })})`,
            organization: orgUserId
                ? sql<boolean>`${sharedItemCondition(orgUserId)}`
                : sql<boolean>`false`,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, itemId),
                isNull(chatterItems.deletedAt),
                sql`(${chatterItems.userId} = ${userId} or ${restrictedItemCondition({ userId, isCurator })} or ${orgUserId ? sharedItemCondition(orgUserId) : sql`false`})`,
            ),
        );
    if (!item)
        throw new AppError(ErrorCode.NOT_FOUND, ErrorCode.NOT_FOUND, 404);
    const members = await db
        .selectDistinct({
            userId: users.id,
            name: users.name,
            email: users.email,
        })
        .from(users)
        .where(
            sql`${users.id} = ${item.ownerUserId} or ${users.id} in (select ${restrictedFolderMembers.userId} from ${restrictedFolderMembers} inner join ${recordingFolderAssignments} on ${recordingFolderAssignments.folderId} = ${restrictedFolderMembers.folderId} inner join ${recordingFolders} on ${recordingFolders.id} = ${recordingFolderAssignments.folderId} where ${recordingFolderAssignments.itemId} = ${itemId} and ${recordingFolderAssignments.withheld} and ${restrictedMemberCondition(users.id, restrictedFolderMembers.folderId)} and ${placementVisibleCondition({ userId, isCurator })})`,
        );
    return {
        ownerUserId: item.ownerUserId,
        readers: members,
        organization: item.organization,
        restricted: item.restricted,
        curatorsCanRead: item.restricted || item.organization,
    };
}
