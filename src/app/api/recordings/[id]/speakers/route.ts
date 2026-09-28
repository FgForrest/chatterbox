import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { recordings, transcriptions } from "@/db/schema";
import { requireApiSession } from "@/lib/auth-server";
import { AppError, apiHandler, ErrorCode } from "@/lib/errors";
import { refreshExistingRecordingSidecars } from "@/lib/export/document-sidecars";
import {
    clearTranscriptSpeaker,
    getTranscriptSpeakers,
    rejectSuggestion,
    setTranscriptSpeaker,
    type TranscriptSpeaker,
} from "@/lib/knowledge/attribution";
import {
    createPerson,
    getPerson,
    MAX_DISPLAY_NAME_LENGTH,
    promotePerson,
} from "@/lib/knowledge/people";
import { speakerKey } from "@/lib/knowledge/speaker-label-rules";
import { assertOrgScopeWritable, isOrgScopeEnabled } from "@/lib/org/config";
import {
    requestedRecordingView,
    requireRecordingView,
} from "@/lib/sharing/access";
import { orgContentChanged } from "@/lib/sharing/notify";
import { ensureOrgTranscript } from "@/lib/sharing/org-transcript";
import { effectiveViewReader } from "@/lib/sharing/view-content";

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
        const reader = await effectiveViewReader(id, access, "transcript");
        const transcript = await requireTranscript(reader.userId, id, request);
        const speakers = await getTranscriptSpeakers(
            reader.userId,
            transcript.id,
            { orgPeopleOnly: true },
        );
        // On the owner's transcript only confirmed names are shown: a
        // machine's guess there is the owner's to review, not everyone's to
        // read. The Organization's own transcript is everyone's to curate,
        // suggestions included.
        return NextResponse.json({
            transcriptionId: transcript.id,
            revision: transcript.revision,
            fallback: reader.fallback,
            speakers: reader.fallback
                ? speakers.filter((speaker) => speaker.status === "confirmed")
                : speakers,
        });
    }

    await requireRecordingView(session.user.id, id, "private");
    const transcript = await requireTranscript(session.user.id, id, request);

    return NextResponse.json({
        transcriptionId: transcript.id,
        revision: transcript.revision,
        speakers: await getTranscriptSpeakers(session.user.id, transcript.id),
    });
});

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
        throw new AppError(
            ErrorCode.CONFLICT,
            "The transcript changed; reload",
            409,
        );
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
 * `?view=org` changes a speaker of the Organization view, for everyone: only
 * Organization people may be picked, a new name becomes an Organization
 * person, and the owner's own transcript is never touched.
 */
export const PUT = apiHandler<IdContext>(async (request, context) => {
    const session = await requireApiSession(request);
    const { id } = await (context as IdContext).params;
    const view = requestedRecordingView(request);
    const access = await requireRecordingView(session.user.id, id, view);
    const change = readChange(await request.json().catch(() => null));

    if (view === "org" && access.orgUserId) {
        assertOrgScopeWritable();
        const orgUserId = access.orgUserId;

        // Checked before anything is copied, so a bad request leaves no trace.
        let personId: string | null = null;
        if (change.kind === "name" && change.personId) {
            const person = await currentPerson(
                session.user.id,
                change.personId,
            );
            if (!person || person.scope !== "org") throw personNotFound();
            personId = person.id;
        }
        if (change.kind === "reject") {
            const person = await getPerson(session.user.id, change.personId);
            if (!person || person.scope !== "org") throw personNotFound();
        }
        // What the view showed: the Organization's own transcript, or the
        // owner's until the Organization has one. The first change copies
        // the owner's, keeping its revision, so the check below still holds.
        const reader = await effectiveViewReader(id, access, "transcript");
        assertSeenVersion(
            change,
            await requireTranscript(reader.userId, id, request),
        );
        const transcript = await ensureOrgTranscript(
            id,
            requestedSource(request),
            access,
            session.user.id,
        );
        if (change.kind === "name" && !personId && change.displayName) {
            const created = await createPerson({
                userId: orgUserId,
                displayName: change.displayName,
                createdByUserId: session.user.id,
            });
            personId = created.id;
        }

        await applyChange(change, {
            userId: orgUserId,
            transcriptionId: transcript.id,
            personId,
            actorUserId: session.user.id,
        });
        await orgContentChanged(id);
        return NextResponse.json({
            transcriptionId: transcript.id,
            revision: transcript.revision,
            speakers: await getTranscriptSpeakers(orgUserId, transcript.id, {
                orgPeopleOnly: true,
            }),
        });
    }

    const transcript = await requireTranscript(session.user.id, id, request);
    assertSeenVersion(change, transcript);

    let personId: string | null = null;
    if (change.kind === "name" && change.personId) {
        const person = await currentPerson(session.user.id, change.personId);
        if (!person) throw personNotFound();
        personId = person.id;
    } else if (change.kind === "name" && change.displayName) {
        const created = await createPerson({
            userId: session.user.id,
            displayName: change.displayName,
        });
        personId = created.id;
    } else if (change.kind === "reject") {
        if (!(await getPerson(session.user.id, change.personId))) {
            throw personNotFound();
        }
    }

    await applyChange(change, {
        userId: session.user.id,
        transcriptionId: transcript.id,
        personId,
        actorUserId: session.user.id,
    });

    // A suggestion is never shown outside this panel, so taking one back
    // changes nothing anyone else reads.
    if (change.kind !== "reject") {
        // While the Organization view still shows this transcript, a name
        // confirmed on it is a name everyone reads, so its person joins the
        // Organization's knowledge base.
        if (
            personId &&
            access.shared &&
            access.orgUserId &&
            isOrgScopeEnabled()
        ) {
            const reader = await effectiveViewReader(
                id,
                {
                    ownerUserId: access.ownerUserId,
                    contentUserId: access.orgUserId,
                },
                "transcript",
            );
            if (reader.fallback) {
                await promotePerson(personId, access.orgUserId);
                await orgContentChanged(id);
            }
        }

        // A rename changes what every downstream reader of this recording
        // sees, and `GET /api/v1/recordings` pages on `updatedAt`, so a client
        // syncing incrementally would otherwise never learn about it.
        await db
            .update(recordings)
            .set({ updatedAt: new Date() })
            .where(
                and(
                    eq(recordings.id, id),
                    eq(recordings.userId, session.user.id),
                ),
            );

        await refreshExistingRecordingSidecars(session.user.id, id);
    }

    const speakers: TranscriptSpeaker[] = await getTranscriptSpeakers(
        session.user.id,
        transcript.id,
    );
    return NextResponse.json({
        transcriptionId: transcript.id,
        revision: transcript.revision,
        speakers,
    });
});

/** Write one change to the transcript's speaker rows. */
async function applyChange(
    change: SpeakerChange,
    target: {
        userId: string;
        transcriptionId: string;
        /** The resolved person for a `name` change. */
        personId: string | null;
        /** The human making the change, recorded on what they confirm. */
        actorUserId: string;
    },
): Promise<void> {
    const where = {
        userId: target.userId,
        transcriptionId: target.transcriptionId,
        revision: change.revision,
        label: change.label,
    };
    switch (change.kind) {
        case "name":
            await setTranscriptSpeaker({
                ...where,
                personId: target.personId,
                source: "user",
                status: "confirmed",
                confirmedByUserId: target.actorUserId,
            });
            return;
        case "unknown":
            await setTranscriptSpeaker({
                ...where,
                personId: null,
                source: "user",
                status: "confirmed",
                markedUnknown: true,
                confirmedByUserId: target.actorUserId,
            });
            return;
        case "clear":
            await clearTranscriptSpeaker(where);
            return;
        case "reject":
            await rejectSuggestion({ ...where, personId: change.personId });
            return;
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
// the user's own.
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
