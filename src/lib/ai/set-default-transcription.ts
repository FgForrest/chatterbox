import { setDefaultProvider } from "@/lib/ai/default-provider";

/**
 * Set (or clear) a user's default transcription provider.
 *
 * `value` is an `api_credentials` id, the managed included sentinel, or
 * null to clear. Writes the authoritative pointer on `user_settings` and
 * mirrors the legacy per-row `isDefaultTranscription` booleans so both
 * stay consistent: all rows cleared, then the chosen credential (if any)
 * flagged. The managed sentinel and null leave no row flagged.
 *
 * Ownership of a credential id must be validated by the caller before
 * calling this.
 */
export async function setDefaultTranscriptionProvider(
    userId: string,
    value: string | null,
): Promise<void> {
    await setDefaultProvider(userId, "transcription", value);
}
