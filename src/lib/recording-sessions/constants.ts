/** Largest single chunk the streaming upload accepts. */
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

/** Total bytes one session may accumulate. Matches the whole-file upload cap. */
export const MAX_SESSION_BYTES = 500 * 1024 * 1024;

/** Chunk indices are 0..MAX_CHUNK_INDEX inclusive. */
export const MAX_CHUNK_INDEX = 9_999;

/** An `open` session nobody has touched for this long is abandoned. */
export const OPEN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Chunks of a `failed` session are kept this long for recovery. */
export const FAILED_SESSION_RETENTION_MS = 48 * 60 * 60 * 1000;

/** Containers the finalize job knows how to remux to Ogg/Opus. */
export const ACCEPTED_SESSION_MIME_TYPES = new Set(["audio/webm", "audio/ogg"]);

export const STOP_REASONS = new Set([
    "user",
    "stream-ended",
    "device-lost",
    "tab-closed",
    "browser-closed",
    // Auto mode: the meeting tab left the meeting URL, or stayed silent for
    // the configured quiet period.
    "meeting-ended",
    "auto-quiet",
    "error",
    "unknown",
]);

/** Free-text limits for client-declared metadata. */
export const MAX_PLATFORM_HINT_LENGTH = 64;
export const MAX_CLIENT_VERSION_LENGTH = 64;
export const MAX_CHANNEL_LABEL_LENGTH = 32;
export const MAX_CHANNELS = 8;
