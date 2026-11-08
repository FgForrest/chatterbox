import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { recordingSessions, users } from "@/db/schema";
import { requireMeetingAccess } from "@/lib/meetings/access";

/** Disclose recording participants only after checking the agenda's current visibility. */
export async function agendaRecordingBy(userId: string, id: string) {
    const { agenda } = await requireMeetingAccess(userId, id);
    const rows = await db
        .selectDistinct({ id: users.id, name: users.name })
        .from(recordingSessions)
        .innerJoin(users, eq(users.id, recordingSessions.userId))
        .where(
            and(
                sql`${recordingSessions.metadata}->>'liveAgendaId' = ${agenda.id}`,
                inArray(recordingSessions.status, ["open", "completing"]),
                gt(
                    recordingSessions.startedAt,
                    new Date(Date.now() - 12 * 3600000),
                ),
                lte(recordingSessions.startedAt, new Date()),
            ),
        )
        .orderBy(users.id);
    return {
        recordingBy: rows.map((row) => ({
            name: row.name,
            self: row.id === userId,
        })),
        cursor: rows.length
            ? `:p${createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}`
            : "",
    };
}
