/** Storage prefix under which one session's chunks live. */
export function recordingSessionPrefix(
    userId: string,
    sessionId: string,
): string {
    return `${userId}/recording-sessions/${sessionId}/`;
}

/**
 * Storage key for one chunk.
 *
 * The hash prefix is part of the key so a re-sent chunk with different
 * bytes never overwrites the file a committed row points at: it lands
 * beside it and is deleted when the conflict is reported.
 */
export function recordingSessionChunkKey(
    userId: string,
    sessionId: string,
    index: number,
    sha256: string,
): string {
    const paddedIndex = String(index).padStart(6, "0");
    return `${recordingSessionPrefix(userId, sessionId)}chunk-${paddedIndex}-${sha256.slice(0, 8)}`;
}
