const MEET_API = "https://meet.googleapis.com/v2";
const MAX_CONFERENCE_PAGES = 2;
const MAX_PARTICIPANT_PAGES = 2;
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 5_000;
const MATCH_MARGIN_MS = 15 * 60_000;

interface ConferenceRecord {
    name?: string;
    startTime?: string;
    endTime?: string;
    expireTime?: string;
}

interface Participant {
    name?: string;
    signedinUser?: { user?: string; displayName?: string };
    anonymousUser?: { displayName?: string };
    phoneUser?: { displayName?: string };
}

interface ConferencePage {
    conferenceRecords?: ConferenceRecord[];
    nextPageToken?: string;
}

interface ParticipantPage {
    participants?: Participant[];
    nextPageToken?: string;
}

export interface MeetParticipantCandidate {
    displayName: string;
    source: "signed_in" | "anonymous";
    googleUserId: string | null;
}

export type MeetContextResult =
    | {
          status: "available";
          conferenceRecord: string;
          participants: MeetParticipantCandidate[];
      }
    | {
          status: "unavailable";
          reason:
              | "invalid_input"
              | "expired"
              | "no_match"
              | "ambiguous_match"
              | "incomplete"
              | "request_failed";
      };

export interface MeetContextInput {
    accessToken: string;
    meetingCode: string;
    recordingStartedAt: Date;
    recordingEndedAt: Date;
    fetchImpl?: typeof fetch;
    now?: Date;
}

function validDate(value: Date): boolean {
    return value instanceof Date && Number.isFinite(value.getTime());
}

function matchesRecording(
    record: ConferenceRecord,
    startedAt: number,
    endedAt: number,
    now: number,
): boolean {
    const start = Date.parse(record.startTime ?? "");
    const end = Date.parse(record.endTime ?? "");
    const expiry = Date.parse(record.expireTime ?? "");
    return (
        /^conferenceRecords\/[A-Za-z0-9_-]+$/.test(record.name ?? "") &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        Number.isFinite(expiry) &&
        expiry > now &&
        start <= endedAt + MATCH_MARGIN_MS &&
        end >= startedAt - MATCH_MARGIN_MS
    );
}

async function getPage<T>(
    url: URL,
    accessToken: string,
    fetchImpl: typeof fetch,
): Promise<T> {
    const response = await fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok)
        throw new Error(`Meet request failed: ${response.status}`);
    return (await response.json()) as T;
}

/** Retrieves recent Meet attendees as identity candidates for one recording. */
export async function getMeetParticipantContext(
    input: MeetContextInput,
): Promise<MeetContextResult> {
    const code = input.meetingCode.toLowerCase();
    if (
        !input.accessToken ||
        !/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(code) ||
        !validDate(input.recordingStartedAt) ||
        !validDate(input.recordingEndedAt) ||
        input.recordingEndedAt < input.recordingStartedAt ||
        (input.now !== undefined && !validDate(input.now))
    ) {
        return { status: "unavailable", reason: "invalid_input" };
    }

    const now = (input.now ?? new Date()).getTime();
    if (now - input.recordingEndedAt.getTime() >= 30 * 24 * 60 * 60_000) {
        return { status: "unavailable", reason: "expired" };
    }

    const fetchImpl = input.fetchImpl ?? fetch;
    try {
        const records: ConferenceRecord[] = [];
        let pageToken: string | undefined;
        for (
            let pageNumber = 0;
            pageNumber < MAX_CONFERENCE_PAGES;
            pageNumber++
        ) {
            const url = new URL(`${MEET_API}/conferenceRecords`);
            url.searchParams.set("filter", `space.meeting_code = "${code}"`);
            url.searchParams.set("pageSize", String(PAGE_SIZE));
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const page = await getPage<ConferencePage>(
                url,
                input.accessToken,
                fetchImpl,
            );
            if (!Array.isArray(page.conferenceRecords)) {
                return { status: "unavailable", reason: "incomplete" };
            }
            records.push(...page.conferenceRecords);
            pageToken = page.nextPageToken;
            if (!pageToken) break;
        }
        if (pageToken) return { status: "unavailable", reason: "incomplete" };

        const matches = records.filter((record) =>
            matchesRecording(
                record,
                input.recordingStartedAt.getTime(),
                input.recordingEndedAt.getTime(),
                now,
            ),
        );
        if (matches.length === 0) {
            return { status: "unavailable", reason: "no_match" };
        }
        if (matches.length > 1) {
            return { status: "unavailable", reason: "ambiguous_match" };
        }

        const conferenceRecord = matches[0].name;
        if (!conferenceRecord) {
            return { status: "unavailable", reason: "incomplete" };
        }
        const participants: MeetParticipantCandidate[] = [];
        pageToken = undefined;
        for (
            let pageNumber = 0;
            pageNumber < MAX_PARTICIPANT_PAGES;
            pageNumber++
        ) {
            const url = new URL(`${MEET_API}/${conferenceRecord}/participants`);
            url.searchParams.set("pageSize", "250");
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const page = await getPage<ParticipantPage>(
                url,
                input.accessToken,
                fetchImpl,
            );
            if (!Array.isArray(page.participants)) {
                return { status: "unavailable", reason: "incomplete" };
            }
            for (const participant of page.participants) {
                const signedIn = participant.signedinUser;
                const name =
                    signedIn?.displayName ??
                    participant.anonymousUser?.displayName;
                if (!name?.trim()) continue;
                participants.push({
                    displayName: name.trim(),
                    source: signedIn ? "signed_in" : "anonymous",
                    googleUserId:
                        signedIn &&
                        /^users\/[A-Za-z0-9_-]+$/.test(signedIn.user ?? "")
                            ? (signedIn.user ?? null)
                            : null,
                });
            }
            pageToken = page.nextPageToken;
            if (!pageToken) break;
        }
        if (pageToken) return { status: "unavailable", reason: "incomplete" };
        return { status: "available", conferenceRecord, participants };
    } catch {
        return { status: "unavailable", reason: "request_failed" };
    }
}
