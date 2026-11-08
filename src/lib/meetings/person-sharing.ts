import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { meetingItemAudienceInTx } from "@/db/queries/meeting-audience";
import { meetingVisibility } from "@/db/queries/meetings";
import { activeShareRecipientCondition } from "@/db/queries/share-recipients";
import { agendaTasks, chatterItems, itemShares, users } from "@/db/schema";
import { decryptText } from "@/lib/encryption/fields";
import { AppError, ErrorCode } from "@/lib/errors";
import { requireMeetingAccess } from "@/lib/meetings/access";
import {
    inviteToItem,
    requirePersonSharing,
} from "@/lib/sharing/person-shares";
import { taskViewerById } from "@/lib/tasks/access";
import { getVisibleTasks } from "@/lib/tasks/tasks";

/** Outcome of agenda recording invitations; a skip without a person covers the whole batch. */
export interface RecordingInvitationReport {
    invited: string[];
    skipped: { userId: string | null; reason: string }[];
}

/**
 * Accepted agenda collaborators and, for the author's task-source disclosure, pending direct
 * invitees. Only the author and accepted direct receivers learn who they are; shared-folder and
 * Organization viewers get nobody.
 */
export async function agendaSharePeople(
    userId: string,
    id: string,
    pending = false,
) {
    await requirePersonSharing(userId);
    const access = await requireMeetingAccess(userId, id);
    const isAuthor = access.agenda.userId === userId;
    if (pending && !isAuthor)
        throw new AppError(ErrorCode.NOT_FOUND, "Agenda not found", 404);
    const invitees = access.agenda.meetingItemId
        ? await db
              .select({
                  id: users.id,
                  name: users.name,
                  active: activeShareRecipientCondition().mapWith(Boolean),
              })
              .from(itemShares)
              .innerJoin(users, eq(users.id, itemShares.receiverUserId))
              .where(
                  and(
                      eq(itemShares.itemId, access.agenda.meetingItemId),
                      eq(itemShares.userId, access.agenda.userId),
                      isNull(itemShares.folderShareId),
                      inArray(
                          itemShares.state,
                          pending ? ["pending", "accepted"] : ["accepted"],
                      ),
                  ),
              )
        : [];
    if (!isAuthor && !invitees.some((person) => person.id === userId))
        return { access, people: [], inactivePeople: [] };
    const people = invitees
        .filter((person) => person.active)
        .map(({ id, name }) => ({ id, name }));
    if (!isAuthor) {
        const [author] = await db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(
                and(
                    eq(users.id, access.agenda.userId),
                    activeShareRecipientCondition(),
                ),
            );
        if (author) people.push(author);
    }
    return {
        access,
        people: people.filter((person) => person.id !== userId),
        inactivePeople: invitees.filter((person) => !person.active),
    };
}

/** People needing a recording invitation; recording ownership is checked before any disclosure. */
export async function agendaRecordingShareOffer(
    userId: string,
    id: string,
    recordingId: string,
    pending = false,
) {
    const { access, people } = await agendaSharePeople(userId, id, pending);
    return recordingShareOffer(userId, recordingId, access, people);
}

async function recordingShareOffer(
    userId: string,
    recordingId: string,
    access: Awaited<ReturnType<typeof requireMeetingAccess>>,
    people: { id: string; name: string | null }[],
) {
    const [recording] = await db
        .select({ id: chatterItems.id, title: chatterItems.title })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, recordingId),
                eq(chatterItems.userId, userId),
                eq(chatterItems.kind, "audio"),
                isNull(chatterItems.deletedAt),
            ),
        );
    if (!recording)
        throw new AppError(ErrorCode.NOT_FOUND, "Recording not found", 404);
    const [audience, invited] = await Promise.all([
        db.transaction((tx) =>
            meetingItemAudienceInTx(
                tx,
                recordingId,
                userId,
                access.viewer.orgUserId,
            ),
        ),
        people.length
            ? db
                  .select({ id: itemShares.receiverUserId })
                  .from(itemShares)
                  .where(
                      and(
                          eq(itemShares.itemId, recordingId),
                          eq(itemShares.userId, userId),
                          inArray(
                              itemShares.receiverUserId,
                              people.map((person) => person.id),
                          ),
                          inArray(itemShares.state, ["pending", "accepted"]),
                      ),
                  )
            : [],
    ]);
    const invitedIds = new Set(invited.map((share) => share.id));
    return {
        recordingItemId: recordingId,
        title: decryptText(recording.title),
        organization: audience.organization,
        people: people.filter(
            (person) =>
                !audience.organization &&
                !audience.userIds.has(person.id) &&
                !invitedIds.has(person.id),
        ),
    };
}

/** Best-effort ordinary invitations after a successful attachment or an explicit owner action. */
export async function inviteAgendaPeopleToRecording(
    userId: string,
    id: string,
    recordingId: string,
    taskSource = false,
): Promise<RecordingInvitationReport> {
    const report: RecordingInvitationReport = { invited: [], skipped: [] };
    const { access, people, inactivePeople } = await agendaSharePeople(
        userId,
        id,
        taskSource,
    );
    if (taskSource && access.agenda.snapshotSourceItemId !== recordingId)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Recording is not the task source of this agenda",
            409,
        );
    const offer = await recordingShareOffer(
        userId,
        recordingId,
        access,
        people,
    );
    if (!taskSource && access.agenda.recordingItemId !== recordingId)
        throw new AppError(
            ErrorCode.CONFLICT,
            "Recording is not attached to this agenda",
            409,
        );
    report.skipped.push(
        ...inactivePeople.map((person) => ({
            userId: person.id,
            reason: "inactive",
        })),
    );
    const missing = new Set(offer.people.map((person) => person.id));
    for (const person of people) {
        if (!missing.has(person.id)) {
            report.skipped.push({
                userId: person.id,
                reason: offer.organization
                    ? "organization"
                    : "already_visible_or_invited",
            });
            continue;
        }
        try {
            const shares = await inviteToItem(userId, recordingId, [person.id]);
            if (
                shares.some(
                    (share) =>
                        share.receiverUserId === person.id &&
                        (share.state === "pending" ||
                            share.state === "accepted"),
                )
            )
                report.invited.push(person.id);
            else report.skipped.push({ userId: person.id, reason: "folder" });
        } catch (error) {
            report.skipped.push({
                userId: person.id,
                reason: error instanceof AppError ? error.code : "unavailable",
            });
        }
    }
    return report;
}

/** Author-only disclosure of agenda review tasks unavailable to direct invitees. */
export async function agendaTaskShareDisclosure(userId: string, id: string) {
    const { access, people } = await agendaSharePeople(userId, id, true);
    if (access.agenda.userId !== userId)
        throw new AppError(ErrorCode.NOT_FOUND, "Agenda not found", 404);
    const sourceId = access.agenda.snapshotSourceItemId;
    if (!sourceId || !people.length) return null;
    const [source] = await db
        .select({
            id: chatterItems.id,
            title: chatterItems.title,
            userId: chatterItems.userId,
        })
        .from(chatterItems)
        .where(
            and(
                eq(chatterItems.id, sourceId),
                meetingVisibility(userId, access.viewer.orgUserId),
            ),
        );
    if (!source) return null;
    const links = await db
        .select({ taskId: agendaTasks.taskId })
        .from(agendaTasks)
        .where(
            and(
                eq(agendaTasks.agendaId, access.agenda.id),
                eq(agendaTasks.userId, userId),
                eq(agendaTasks.origin, "last_meeting"),
                isNull(agendaTasks.removedAt),
            ),
        );
    const taskIds = links.map((link) => link.taskId);
    const ownTasks = await getVisibleTasks(
        { ...(await taskViewerById(userId)), includeReceived: true },
        taskIds,
    );
    const hidden = new Set<string>();
    for (const person of people) {
        const [visible] = await db
            .select({ id: chatterItems.id })
            .from(chatterItems)
            .where(
                and(
                    eq(chatterItems.id, sourceId),
                    meetingVisibility(person.id, access.viewer.orgUserId),
                ),
            );
        if (visible) continue;
        const tasks = await getVisibleTasks(
            { ...(await taskViewerById(person.id)), includeReceived: true },
            taskIds,
        );
        const visibleIds = new Set(tasks.map((task) => task.id));
        for (const task of ownTasks)
            if (!visibleIds.has(task.id)) hidden.add(task.id);
    }
    return hidden.size
        ? {
              count: hidden.size,
              title: decryptText(source.title),
              recordingItemId: source.id,
              canInvite: source.userId === userId,
          }
        : null;
}
