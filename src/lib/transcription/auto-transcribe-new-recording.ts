import { resolveItemProfile } from "@/lib/profiles/resolve";
import { enqueueTranscriptionJob } from "@/lib/transcription/transcription-job";

/** Queue transcription when the recording's profile enables automation. */
export async function autoTranscribeNewRecording(
    userId: string,
    recordingId: string,
): Promise<boolean> {
    const profile = await resolveItemProfile(recordingId, "private", userId);
    if (!("transcribe" in profile.settings.steps)) return false;
    const transcribe = profile.settings.steps.transcribe;
    if (!transcribe.enabled || !transcribe.automatic) return false;
    await enqueueTranscriptionJob({
        userId,
        recordingId,
        trigger: "upload",
    });
    return true;
}
