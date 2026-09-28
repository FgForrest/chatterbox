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
 * The rule follows the Organization this instance shows. Switched to
 * `local` mode there is none, and the owner changes their recording again;
 * switched back, the Organization sees it as it is then.
 *
 * - `"shared"`: shared, and the actor is not the organization account;
 *   for the owner that is a 409 (withdraw it first).
 * - `"withdrawn"`: not shared, and the actor is not the owner; to them the
 *   recording is gone (a queued Organization run after a withdrawal).
 */
export type WriterRefusal = "shared" | "withdrawn";

export function writerRefusal({
    actorUserId,
    ownerUserId,
    orgUserId,
    shared,
}: {
    actorUserId: string;
    ownerUserId: string;
    orgUserId: string | null;
    shared: boolean;
}): WriterRefusal | null {
    if (shared && orgUserId !== null) {
        return actorUserId === orgUserId ? null : "shared";
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
    {
        recordingId,
        ownerUserId,
        actorUserId,
        orgUserId,
    }: {
        recordingId: string;
        ownerUserId: string;
        actorUserId: string;
        orgUserId: string | null;
    },
): Promise<WriterRefusal | null> {
    const shared =
        orgUserId !== null &&
        (await isRecordingShared(recordingId, orgUserId, executor));
    return writerRefusal({ actorUserId, ownerUserId, orgUserId, shared });
}
