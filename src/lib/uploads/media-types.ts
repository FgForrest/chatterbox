// Shared with the browser upload queue, so no Node imports here.

export const AUDIO_UPLOAD_EXTENSIONS = new Set([
    ".mp3",
    ".mp4",
    ".m4a",
    ".wav",
    ".ogg",
    ".opus",
    ".webm",
    ".aac",
    ".flac",
]);

export const VIDEO_UPLOAD_EXTENSIONS = new Set([
    ".mp4",
    ".mov",
    ".m4v",
    ".webm",
    ".mkv",
    ".avi",
    ".mpeg",
    ".mpg",
    ".wmv",
    ".3gp",
    ".ogv",
]);

/**
 * Audio uploads are read into memory for duration probing, hashing and the
 * waveform, so they keep a fixed cap. Videos stream to storage and are
 * capped by `VIDEO_UPLOAD_MAX_BYTES` instead.
 */
export const AUDIO_UPLOAD_MAX_BYTES = 500 * 1024 * 1024;

const AMBIGUOUS_CONTAINER_EXTENSIONS = new Set([".mp4", ".webm"]);

/** Lowercase extension with its dot, `""` when there is none (like `path.extname`). */
export function uploadExtension(filename: string): string {
    const basename = filename.split(/[\\/]/).pop() ?? "";
    const dot = basename.lastIndexOf(".");
    return dot > 0 ? basename.slice(dot).toLowerCase() : "";
}

export function isSupportedUpload(filename: string, mimeType: string): boolean {
    const extension = uploadExtension(filename);
    return (
        mimeType.toLowerCase().startsWith("video/") ||
        AUDIO_UPLOAD_EXTENSIONS.has(extension) ||
        VIDEO_UPLOAD_EXTENSIONS.has(extension)
    );
}

export function shouldExtractVideo(
    filename: string,
    mimeType: string,
): boolean {
    const extension = uploadExtension(filename);
    if (mimeType.toLowerCase().startsWith("video/")) return true;
    if (!VIDEO_UPLOAD_EXTENSIONS.has(extension)) return false;
    if (!AMBIGUOUS_CONTAINER_EXTENSIONS.has(extension)) return true;
    return !mimeType.toLowerCase().startsWith("audio/");
}

export function acceptedUploadExtensions(): string {
    return [
        ...new Set([...AUDIO_UPLOAD_EXTENSIONS, ...VIDEO_UPLOAD_EXTENSIONS]),
    ]
        .sort()
        .join(", ");
}

/** Human-readable upload limit, e.g. `500 MB` or `4 GB`. */
export function formatUploadLimit(bytes: number): string {
    const gib = bytes / 1024 ** 3;
    if (gib >= 1 && Number.isInteger(gib * 10)) return `${gib} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
}
