import { isRecordingShared } from "@/lib/sharing/shared";

// Free of anything that validates the environment, so the knowledge modules
// the summary and export paths load can check the rule; the organization
// account is resolved by the caller (`sharing/writer.ts`).

type Executor = Parameters<typeof isRecordingShared>[2];

/**
 * Who may change a recording's content: its transcripts, speakers,
 * summaries, topics and title.
 *
 * A shared recording is one recording, and sharing hands it over: while it
 * is shared only the organization account changes it, and its owner reads
 * it, withdraws it, or erases it (which withdraws it). Otherwise only its
 * owner changes it. Withdrawal gives it back as the Organization left it.
 *
 * Not content: caches derived from the audio (waveform peaks, which only
 * fill a missing value), storage housekeeping (file names following the
 * title), and the Plaud original in its owner's Plaud account. Nor are
 * operations on a person (rename, merge, delete): they act on the person,
 * and reach every recording naming them, shared or not.
 *
 * The rule follows the Organization this instance shows. Switched to
 * `local` mode there is none, and the owner changes their recording again;
 * switched back, the Organization sees it as it is then.
 *
 * Who changes a shared recording "for the Organization": the organization
 * account, or a curator acting under their own identity. The caller says
 * which (`actsForOrganization`, decided by the server from the actor's
 * verified access); left out, only the organization account does.
 *
 * - `"shared"`: shared, and the actor does not act for the Organization;
 *   for the owner that is a 409 (withdraw it first).
 * - `"withdrawn"`: not shared, and the actor is not the owner; to them the
 *   recording is gone (a queued Organization run after a withdrawal).
 */
export type WriterRefusal = "shared" | "withdrawn";

/** Whether `actorUserId` acts for the Organization: told, else the organization account. */
function actsForOrg(input: {
    actorUserId: string;
    orgUserId: string | null;
    actsForOrganization?: boolean;
}): boolean {
    return (
        input.actsForOrganization ??
        (input.orgUserId !== null && input.actorUserId === input.orgUserId)
    );
}

export function writerRefusal(input: {
    actorUserId: string;
    ownerUserId: string;
    orgUserId: string | null;
    shared: boolean;
    actsForOrganization?: boolean;
}): WriterRefusal | null {
    const { actorUserId, ownerUserId, orgUserId, shared } = input;
    if (shared && orgUserId !== null) {
        return actsForOrg(input) ? null : "shared";
    }
    return actorUserId === ownerUserId ? null : "withdrawn";
}

/**
 * Whether `actorUserId` may change the recording's content now. Call it
 * under the recording lock, which sharing and withdrawal take too, so a
 * run that began before either and ends after it writes nothing.
 */
export async function contentWriterRefusal(
    executor: Executor,
    input: {
        recordingId: string;
        ownerUserId: string;
        actorUserId: string;
        orgUserId: string | null;
        actsForOrganization?: boolean;
    },
): Promise<WriterRefusal | null> {
    return (await contentWriterScope(executor, input)).refusal;
}

/**
 * {@link contentWriterRefusal}, and the knowledge scope the change writes
 * into when allowed: the Organization's on a shared recording, the
 * actor's own otherwise. The actor stays the author (`createdBy`).
 */
export async function contentWriterScope(
    executor: Executor,
    input: {
        recordingId: string;
        ownerUserId: string;
        actorUserId: string;
        orgUserId: string | null;
        actsForOrganization?: boolean;
    },
): Promise<{ refusal: WriterRefusal | null; scopeUserId: string }> {
    const { recordingId, orgUserId, actorUserId } = input;
    const shared =
        orgUserId !== null &&
        (await isRecordingShared(recordingId, orgUserId, executor));
    const refusal = writerRefusal({ ...input, shared });
    return {
        refusal,
        scopeUserId: shared && orgUserId !== null ? orgUserId : actorUserId,
    };
}
