import type { LearnSpeakerCandidate } from "@/lib/learn/run-fallback";
import {
    type CalendarEventCandidate,
    getSelectedCalendarMeetCode,
} from "./calendar-events";
import { getGoogleAccessToken, getGoogleConnectionStatus } from "./connection";
import { GOOGLE_MEET_READ_SCOPE } from "./meet-consent";
import { getMeetParticipantContext } from "./meet-context";

const MAX_LEARN_CANDIDATES = 80;

/** Best-effort Meet attendees for an owner-selected Calendar event. */
export async function getMeetSpeakerCandidates(input: {
    userId: string;
    event: CalendarEventCandidate;
    recordingStartedAt: Date;
    recordingEndedAt: Date;
    fetchImpl?: typeof fetch;
}): Promise<LearnSpeakerCandidate[]> {
    try {
        const connection = await getGoogleConnectionStatus(input.userId);
        if (
            connection?.status !== "active" ||
            !connection.scopes.includes(GOOGLE_MEET_READ_SCOPE)
        ) {
            return [];
        }
        const meetingCode = await getSelectedCalendarMeetCode({
            userId: input.userId,
            event: input.event,
            fetchImpl: input.fetchImpl,
        });
        if (!meetingCode) return [];
        const accessToken = await getGoogleAccessToken(input.userId, {
            expectedSubject: connection.subject,
            requiredScope: GOOGLE_MEET_READ_SCOPE,
            fetchImpl: input.fetchImpl,
        });
        const context = await getMeetParticipantContext({
            accessToken,
            meetingCode,
            recordingStartedAt: input.recordingStartedAt,
            recordingEndedAt: input.recordingEndedAt,
            fetchImpl: input.fetchImpl,
        });
        if (context.status !== "available") return [];
        const names = new Map<string, string>();
        for (const participant of context.participants) {
            const name = participant.displayName.slice(0, 120);
            const key = name.toLocaleLowerCase();
            if (!names.has(key)) names.set(key, name);
            if (names.size >= MAX_LEARN_CANDIDATES) break;
        }
        return [...names.values()].map((name) => ({ name, source: "meet" }));
    } catch {
        return [];
    }
}
