import {
    notifySharedAgenda,
    queryRecorderRoom,
    queryRoomInvitationIds,
    queryRoomPeople,
    refreshRecorderPresence,
} from "@/db/queries/recorder-rooms";
import { AppError, ErrorCode } from "@/lib/errors";
import { meetingViewer, requireMeetingAccess } from "@/lib/meetings/access";
import { matchRecorderAgendas } from "@/lib/meetings/calendar";
import { readMeetingCalendarSnapshot } from "@/lib/meetings/calendar-snapshot";
import { agendaRecordingBy } from "@/lib/meetings/recording-by";
import { recorderRoomKey } from "@/lib/meetings/room-key";
import { listMeetings } from "@/lib/meetings/service";
import { isOrgScopeVisible } from "@/lib/org/config";
import {
    inviteToItem,
    listMyInvitations,
    requirePersonSharing,
} from "@/lib/sharing/person-shares";

/** Match visible Calendar and room-bound agendas, disclosing only a boolean for restricted plans. */
export async function matchRecorderRoom(
    userId: string,
    at: Date,
    meetCode?: string,
    scheduleRefresh?: (refresh: () => Promise<void>) => void,
) {
    const calendar = await matchRecorderAgendas(
        userId,
        at,
        meetCode,
        scheduleRefresh,
    );
    const key = recorderRoomKey(meetCode);
    if (!key) return { data: calendar, restricted: false, invitations: [] };
    const viewer = await meetingViewer(userId);
    const [room, invited] = await Promise.all([
        queryRecorderRoom(viewer, key),
        isOrgScopeVisible() ? queryRoomInvitationIds(viewer, key) : [],
    ]);
    const rows = room.ids.length
        ? await listMeetings(userId, {
              ids: room.ids,
              includePast: true,
              excludeAbsorbed: true,
          })
        : [];
    const data = [
        ...new Map([...calendar, ...rows].map((row) => [row.id, row])).values(),
    ];
    const invitations = invited.length
        ? (await listMyInvitations(userId)).flatMap((invitation) => {
              const bound = invited.find((row) => row.id === invitation.id);
              return bound
                  ? [
                        {
                            id: invitation.id,
                            agendaId: bound.agendaId,
                            title: invitation.title,
                            start: invitation.plannedStart,
                            end: bound.end,
                            sharerName: bound.sharerName,
                            version: invitation.version,
                            visibleInFolders: invitation.visibleInFolders,
                        },
                    ]
                  : [];
          })
        : [];
    return {
        data: await Promise.all(
            data.map(async (row) => ({
                ...row,
                roomBound: room.ids.includes(row.id),
                chosenBy: (
                    await agendaRecordingBy(userId, row.id, key)
                ).recordingBy.map((person) => ({
                    name: person.name,
                    self: person.self,
                })),
            })),
        ),
        restricted: room.restricted,
        invitations,
    };
}

/** Presence is a caller's explicit open-panel declaration, never an arbitrary agenda binding. */
export async function recorderPanelPresence(
    userId: string,
    meetCode: string,
    agendaId: string | null,
) {
    const key = recorderRoomKey(meetCode);
    if (!key)
        throw new AppError(ErrorCode.INVALID_INPUT, "Invalid room code", 400);
    const access = agendaId
        ? await requireMeetingAccess(userId, agendaId)
        : null;
    if (access?.agenda.recordingItemId)
        throw new AppError(ErrorCode.CONFLICT, "Agenda is read-only", 409);
    return refreshRecorderPresence(userId, key, access?.agenda.id ?? null);
}

async function requireAgendaOwner(userId: string, id: string) {
    await requirePersonSharing(userId);
    const access = await requireMeetingAccess(userId, id);
    if (
        access.agenda.userId !== userId ||
        !access.agenda.meetingItemId ||
        access.agenda.recordingItemId
    )
        throw new AppError(ErrorCode.NOT_FOUND, "Agenda not found", 404);
    return access;
}

/** The author alone sees panel users in the room from the agenda's own Calendar event. */
export async function recorderAgendaPeople(userId: string, id: string) {
    const access = await requireAgendaOwner(userId, id);
    const event = await readMeetingCalendarSnapshot(access.agenda);
    const calendarKey = recorderRoomKey(event?.meetingCode);
    if (!calendarKey) return [];
    const keys = [calendarKey];
    const people = await queryRoomPeople(access.viewer, access.agenda.id, keys);
    const visible = await Promise.all(
        people.map(async (person) => {
            try {
                await requireMeetingAccess(person.id, access.agenda.id);
                return null;
            } catch (error) {
                if (error instanceof AppError && error.statusCode === 404)
                    return person;
                throw error;
            }
        }),
    );
    return visible.filter((person) => person !== null);
}

/** Reuse web sharing checks and additionally limit panel invitations to the owner's room list. */
export async function inviteRecorderAgendaPeople(
    userId: string,
    id: string,
    receiverIds: string[],
) {
    const access = await requireAgendaOwner(userId, id);
    const people = await recorderAgendaPeople(userId, id);
    if (receiverIds.some((id) => !people.some((person) => person.id === id)))
        throw new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
    await inviteToItem(userId, access.item.id, receiverIds);
    await notifySharedAgenda(userId, access.item.id);
    return recorderAgendaPeople(userId, id);
}
