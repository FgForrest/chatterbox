import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import {
    getTranscriptSpeakers,
    type TranscriptSpeaker,
    transcriptChanged,
} from "@/lib/knowledge/attribution";
import { getPerson, MAX_DISPLAY_NAME_LENGTH } from "@/lib/knowledge/people";
import {
    changeTranscriptSpeaker,
    type SpeakerAnswer,
} from "@/lib/knowledge/speaker-changes";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { notifyIfShared } from "@/lib/sharing/notify";
import { assertMayChange } from "@/lib/sharing/writer";

type IdContext = { params: Promise<{ id: string }> };

function requestedSource(request: Request): string {
    return new URL(request.url).searchParams.get("source") ?? "riffado";
}

export const GET = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);

    if (view === "org") {
        const access = await requireRecordingView(session.user.id, id, view);
        const transcript = await requireTranscript(
            access.ownerUserId,
            id,
            request,
        );
        const speakers = await getTranscriptSpeakers(
            access.ownerUserId,
            transcript.id,
            { orgPeopleOnly: true },
        );
        return NextResponse.json({
            transcriptionId: transcript.id,
            revision: transcript.revision,
            speakers: orgViewSpeakers(speakers, {
                curator: session.user.id === access.orgUserId,
            }),
        });
    }

    const access = await requireRecordingView(session.user.id, id, "private");
    const transcript = await requireTranscript(session.user.id, id, request);
    const speakers = await getTranscriptSpeakers(
        session.user.id,
        transcript.id,
    );

    return NextResponse.json({
        transcriptionId: transcript.id,
        revision: transcript.revision,
        // Shared, a suggestion is the organization account's to review.
        speakers: access.shared
            ? speakers.filter((speaker) => speaker.status === "confirmed")
            : speakers,
    });
});

/**
 * The speaker rows the Organization view shows.
 *
 * A suggestion is shown only to whoever may act on it: the organization
 * account, which changes a shared recording. Everyone else reads the
 * confirmed names, without who confirmed them.
 */
function orgViewSpeakers(
    speakers: TranscriptSpeaker[],
    viewer: { curator: boolean },
): TranscriptSpeaker[] {
    if (viewer.curator) return speakers;
    return speakers.flatMap((speaker) =>
        speaker.status === "confirmed"
            ? [{ ...speaker, confirmedByUserId: null }]
            : [],
    );
}

/**
 * What a person said about one speaker label:
 * - `name`: it is this person (an existing one, or a new name);
 * - `unknown`: nobody anyone knows, which is an answer;
 * - `clear`: take the answer back, and leave the label open;
 * - `reject`: it is not the suggested person, and never suggest them again.
 */
type SpeakerChange = SeenVersion &
    (
        | {
              kind: "name";
              label: string;
              personId?: string;
              displayName?: string;
          }
        | { kind: "unknown"; label: string }
        | { kind: "clear"; label: string }
        | { kind: "reject"; label: string; personId: string }
    );

/**
 * The transcript version the person was looking at. Every change names it,
 * so a change made on text that has since been replaced is refused rather
 * than landing on a label that now means someone else.
 */
interface SeenVersion {
    transcriptionId: string;
    revision: number;
}

function readSeenVersion(value: {
    transcriptionId?: unknown;
    revision?: unknown;
}): SeenVersion {
    const { transcriptionId, revision } = value;
    if (transcriptionId === undefined || revision === undefined) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "transcriptionId and revision are required",
            400,
            {
                field:
                    transcriptionId === undefined
                        ? "transcriptionId"
                        : "revision",
            },
        );
    }
    if (typeof transcriptionId !== "string" || !transcriptionId) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "transcriptionId must be a transcript id",
            400,
            { field: "transcriptionId" },
        );
    }
    if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
    ) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "revision must be a non-negative integer",
            400,
            { field: "revision" },
        );
    }
    return { transcriptionId, revision };
}

function readChange(body: unknown): SpeakerChange {
    const value = (body ?? {}) as {
        label?: unknown;
        personId?: unknown;
        displayName?: unknown;
        unknown?: unknown;
        reject?: unknown;
        transcriptionId?: unknown;
        revision?: unknown;
    };
    const seen = readSeenVersion(value);
    const rawLabel = value.label;
    if (typeof rawLabel !== "string" || !rawLabel.trim()) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "label is required",
            400,
            { field: "label" },
        );
    }
    // Stored and compared as the key, so an overlong provider label is the
    // same speaker here as in the transcript it came from.
    const label = speakerKey(rawLabel);
    const personId =
        typeof value.personId === "string" && value.personId
            ? value.personId
            : undefined;

    if (value.reject === true) {
        if (!personId) {
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                "personId is required to reject a suggestion",
                400,
                { field: "personId" },
            );
        }
        return { ...seen, kind: "reject", label, personId };
    }
    if (value.unknown === true) return { ...seen, kind: "unknown", label };
    if (personId) return { ...seen, kind: "name", label, personId };
    if (typeof value.displayName === "string" && value.displayName.trim()) {
        const displayName = value.displayName.trim();
        if (displayName.length > MAX_DISPLAY_NAME_LENGTH) {
            throw new AppError(
                ErrorCode.INVALID_INPUT,
                "That name is too long",
                400,
                { field: "displayName" },
            );
        }
        return { ...seen, kind: "name", label, displayName };
    }
    return { ...seen, kind: "clear", label };
}

/**
 * Refuse a change made on another transcript than the one shown now: the
 * one it was made on was erased and a new one written, which a revision
 * number alone cannot tell apart. The revision itself is compared again
 * under the transcript's lock, where the write happens.
 */
function assertSeenVersion(
    change: SeenVersion,
    shown: { id: string; revision: number },
): void {
    if (
        change.transcriptionId !== shown.id ||
        change.revision !== shown.revision
    ) {
        throw transcriptChanged();
    }
}

function personNotFound(): AppError {
    return new AppError(ErrorCode.NOT_FOUND, "Person not found", 404);
}

/**
 * Name a speaker, mark them unknown, reject a suggestion, or clear the
 * answer.
 *
 * Naming accepts either an existing `personId` or a `displayName` to create
 * one, because the common case is naming somebody the knowledge base has
 * never heard of and making the user create them first would be a needless
 * step.
 *
 * A name or an "unknown" set here is `confirmed` with source `user` and the
 * person who said it: it came from a human looking at the transcript, which
 * is the only evidence this feature treats as strong enough to reach a
 * summary or an export.
 *
 * A shared recording is one recording, and only the organization account
 * changes its speakers, on the Organization view (403 for anyone else):
 * only Organization people may be picked there, and a new name becomes an
 * Organization person. Its owner withdraws it before changing them (409
 * RECORDING_SHARED); both are checked again under the recording lock.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const change = readChange(await request.json().catch(() => null));
    const orgView = view === "org";

    assertMayChange(access, session.user.id);

    const ownerUserId = access.ownerUserId;
    const transcript = await requireTranscript(ownerUserId, id, request);
    assertSeenVersion(change, transcript);

    // Checked before anything is written, so a bad request leaves no trace.
    let existingPersonId: string | null = null;
    if (change.kind === "name" && change.personId) {
        const person = await currentPerson(session.user.id, change.personId);
        if (!person || (orgView && person.scope !== "org")) {
            throw personNotFound();
        }
        existingPersonId = person.id;
    } else if (change.kind === "reject") {
        const person = await getPerson(session.user.id, change.personId);
        if (!person || (orgView && person.scope !== "org")) {
            throw personNotFound();
        }
    }

    await changeTranscriptSpeaker({
        userId: ownerUserId,
        transcriptionId: transcript.id,
        revision: change.revision,
        label: change.label,
        answer: answerOf(change, existingPersonId),
        actorUserId: session.user.id,
        orgUserId: access.orgUserId,
    });

    // A suggestion is never shown outside this panel, so taking one back
    // changes nothing anyone else reads.
    if (change.kind !== "reject") {
        // A rename changes what every downstream reader of this recording
        // sees, and `GET /api/v1/recordings` pages on `updatedAt`, so a client
        // syncing incrementally would otherwise never learn about it.
        await db
            .update(recordings)
            .set({ updatedAt: new Date() })
            .where(
                and(eq(recordings.id, id), eq(recordings.userId, ownerUserId)),
            );

        await refreshExistingRecordingSidecars(ownerUserId, id);
        await notifyIfShared(id);
    }

    const speakers = await getTranscriptSpeakers(
        ownerUserId,
        transcript.id,
        orgView ? { orgPeopleOnly: true } : undefined,
    );
    return NextResponse.json({
        transcriptionId: transcript.id,
        revision: transcript.revision,
        speakers: orgView
            ? orgViewSpeakers(speakers, { curator: true })
            : speakers,
    });
});

/**
 * The answer a change gives. `personId` is the checked person a `name`
 * change picked; a `name` change without one creates a person, in the
 * transaction that writes it.
 */
function answerOf(
    change: SpeakerChange,
    personId: string | null,
): SpeakerAnswer {
    switch (change.kind) {
        case "name":
            if (personId) return { kind: "name", personId };
            if (change.displayName) {
                return { kind: "name", displayName: change.displayName };
            }
            throw new AppError(
                ErrorCode.MISSING_REQUIRED_FIELD,
                "personId or displayName is required",
                400,
            );
        case "reject":
            return { kind: "reject", personId: change.personId };
        case "unknown":
        case "clear":
            return { kind: change.kind };
    }
}

/**
 * The person an id refers to now: a merged-away id resolves to the person
 * it was folded into, so an attribution never lands on a tombstone.
 */
async function currentPerson(userId: string, personId: string) {
    const person = await getPerson(userId, personId);
    if (!person?.mergedIntoId) return person;
    return getPerson(userId, person.mergedIntoId);
}

// The transcript an attribution attaches to.
//
// A recording can hold more than one transcript, and their speaker labels
// are not interchangeable, so the caller says which by source. Defaults to
// Riffado's own.
async function requireTranscript(
    userId: string,
    recordingId: string,
    request: Request,
): Promise<{ id: string; revision: number }> {
    const [transcript] = await db
        .select({ id: transcriptions.id, revision: transcriptions.revision })
        .from(transcriptions)
        .where(
            and(
                eq(transcriptions.recordingId, recordingId),
                eq(transcriptions.userId, userId),
                eq(transcriptions.source, requestedSource(request)),
            ),
        )
        .limit(1);

    if (!transcript) {
        throw new AppError(
            ErrorCode.NOT_FOUND,
            "No transcript to attribute",
            404,
        );
    }

    return transcript;
}
