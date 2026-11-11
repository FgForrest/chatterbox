import { and, eq, or } from "drizzle-orm";
import { db } from "@/db";
import { restrictedItemCondition } from "@/db/queries/restricted-folders";
import {
    meetingAgendas,
    recordingFolderAssignments,
    recordingFolders,
    recordingSessions,
} from "@/db/schema";
import { userCuratesOrganizationNow } from "@/lib/authz/curator";
import { getOrgUserId } from "@/lib/org/config";
import type { ArrivalFolder } from "@/lib/pipeline/arrival";
import { sharedItemCondition } from "@/lib/sharing/shared";

/** Resolve deferred attachment and runtime authority before reserving an arrival transaction. */
export async function resolveArrivalOrganizationContext(input: {
    userId: string;
    folder?: ArrivalFolder | null;
    agendaId?: string;
    fileId: string;
}) {
    let agendaId = input.agendaId;
    if (!agendaId && input.fileId.startsWith("meeting-")) {
        const [session] = await db
            .select({ metadata: recordingSessions.metadata })
            .from(recordingSessions)
            .where(
                and(
                    eq(recordingSessions.userId, input.userId),
                    eq(
                        recordingSessions.clientRecordingId,
                        input.fileId.slice("meeting-".length),
                    ),
                ),
            );
        const outcome = session?.metadata.agendaOutcome;
        const declined =
            outcome !== null &&
            typeof outcome === "object" &&
            "attached" in outcome &&
            outcome.attached === false;
        if (!declined && typeof session?.metadata.agendaId === "string")
            agendaId = session.metadata.agendaId;
    }
    const orgUserId = await getOrgUserId();
    const canCurate =
        input.folder?.scope === "org" || (orgUserId && agendaId)
            ? await userCuratesOrganizationNow(input.userId)
            : false;
    const [organizationAgenda] =
        orgUserId && agendaId
            ? await db
                  .select({ id: meetingAgendas.id })
                  .from(meetingAgendas)
                  .leftJoin(
                      recordingFolderAssignments,
                      eq(
                          recordingFolderAssignments.itemId,
                          meetingAgendas.meetingItemId,
                      ),
                  )
                  .leftJoin(
                      recordingFolders,
                      eq(
                          recordingFolders.id,
                          recordingFolderAssignments.folderId,
                      ),
                  )
                  .where(
                      and(
                          or(
                              eq(meetingAgendas.id, agendaId),
                              eq(meetingAgendas.meetingItemId, agendaId),
                              eq(meetingAgendas.recordingItemId, agendaId),
                          ),
                          or(
                              eq(meetingAgendas.userId, orgUserId),
                              eq(recordingFolders.userId, orgUserId),
                          ),
                          or(
                              eq(meetingAgendas.userId, input.userId),
                              sharedItemCondition(
                                  orgUserId,
                                  meetingAgendas.meetingItemId,
                              ),
                              restrictedItemCondition(
                                  {
                                      userId: input.userId,
                                      isCurator: canCurate,
                                  },
                                  meetingAgendas.meetingItemId,
                              ),
                          ),
                      ),
                  )
                  .limit(1)
            : [];
    return {
        agendaId,
        canCurate,
        lockOrganizationTree: Boolean(
            orgUserId && (input.folder?.scope === "org" || organizationAgenda),
        ),
    };
}
