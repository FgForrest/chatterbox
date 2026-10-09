import { and, eq, isNull } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { listCalendarEventsForRecording } from "@/lib/integrations/google/calendar-events";

type IdContext = { params: Promise<{ id: string }> };

/** Candidate events for the recording owner to choose before manual Learn. */
export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const [recording] = await db
        .select({
            start: recordings.startTime,
            end: recordings.endTime,
        })
        .from(recordings)
        .where(
            and(
                eq(recordings.id, id),
                eq(recordings.userId, session.user.id),
                isNull(recordings.deletedAt),
            ),
        )
        .limit(1);
    if (!recording)
        throw new AppError(
            ErrorCode.RECORDING_NOT_FOUND,
            "Recording not found",
            404,
        );
    try {
        const events = await listCalendarEventsForRecording({
            userId: session.user.id,
            start: recording.start,
            end: recording.end,
        });
        return NextResponse.json({
            events: events.map(({ id, title, start }) => ({
                id,
                title,
                start,
            })),
        });
    } catch {
        return NextResponse.json({ events: [], unavailable: true });
    }
});
