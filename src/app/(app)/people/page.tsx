import { and, countDistinct, eq, isNull, max, or } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PeopleList } from "@/components/people/people-list";
import { db } from "@/db";
import { recordings, transcriptions, transcriptSpeakers } from "@/db/schema";
import { auth } from "@/lib/auth";
import { listPeople } from "@/lib/knowledge/people";
import { getOrgUserId } from "@/lib/org/config";
import { sharedRecordingCondition } from "@/lib/sharing/shared";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) {
        redirect("/login");
    }

    const userId = session.user.id;
    // The names on shared recordings count too, which everyone may see.
    const orgUserId = await getOrgUserId();

    const [rows, appearances] = await Promise.all([
        listPeople(userId),
        // How many recordings each person appears in, and when they were last
        // heard. Both come from the attribution overlay joined back to the
        // recording, which is the only place that link exists.
        db
            .select({
                personId: transcriptSpeakers.personId,
                recordingCount: countDistinct(recordings.id),
                lastSeen: max(recordings.startTime),
            })
            .from(transcriptSpeakers)
            .innerJoin(
                transcriptions,
                eq(transcriptions.id, transcriptSpeakers.transcriptionId),
            )
            .innerJoin(
                recordings,
                eq(recordings.id, transcriptions.recordingId),
            )
            .where(
                and(
                    or(
                        eq(transcriptSpeakers.userId, userId),
                        orgUserId
                            ? sharedRecordingCondition(orgUserId)
                            : undefined,
                    ),
                    eq(transcriptSpeakers.status, "confirmed"),
                    isNull(recordings.deletedAt),
                ),
            )
            .groupBy(transcriptSpeakers.personId),
    ]);

    const stats = new Map(
        appearances.map((row) => [
            row.personId,
            { recordingCount: row.recordingCount, lastSeen: row.lastSeen },
        ]),
    );

    return (
        <div className="container mx-auto max-w-7xl px-4 py-6">
            <PeopleList
                people={rows.map((row) => ({
                    id: row.id,
                    displayName: row.displayName,
                    primaryEmail: row.primaryEmail,
                    scope: row.scope,
                    recordingCount: stats.get(row.id)?.recordingCount ?? 0,
                    lastSeen:
                        stats.get(row.id)?.lastSeen?.toISOString() ?? null,
                }))}
            />
        </div>
    );
}
