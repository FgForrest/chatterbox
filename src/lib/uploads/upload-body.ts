import { Readable } from "node:stream";
import { AppError, ErrorCode } from "@/lib/errors";
import { formatUploadLimit } from "./media-types";

/**
 * The upload route takes the file itself as the request body, not a
 * multipart form: `request.formData()` holds the whole file in memory, and
 * a multi-gigabyte video has to stream to storage instead.
 */
export const UPLOAD_FILENAME_HEADER = "x-upload-filename";
/**
 * The client's own statement of the file size. Content-Length may not
 * survive a reverse proxy that re-chunks the body, so it is only a fallback.
 */
export const UPLOAD_SIZE_HEADER = "x-upload-size";

export interface UploadMetadata {
    filename: string;
    mimeType: string;
    size: number;
}

export function readUploadMetadata(request: Request): UploadMetadata {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "Send the file itself as the request body. Reload the page if this keeps happening.",
            415,
        );
    }

    const encodedFilename = request.headers.get(UPLOAD_FILENAME_HEADER);
    if (!encodedFilename) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "No file provided",
            400,
            { field: "filename" },
        );
    }
    let filename: string;
    try {
        filename = decodeURIComponent(encodedFilename);
    } catch {
        throw new AppError(
            ErrorCode.INVALID_INPUT,
            "The file name is not valid",
            400,
            { field: "filename" },
        );
    }

    const declaredSize =
        request.headers.get(UPLOAD_SIZE_HEADER) ??
        request.headers.get("content-length") ??
        "";
    const size = Number(declaredSize);
    if (!/^\d+$/.test(declaredSize) || !Number.isSafeInteger(size)) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "The upload did not state its size",
            411,
            { field: "size" },
        );
    }
    if (size === 0 || !request.body) {
        throw new AppError(
            ErrorCode.MISSING_REQUIRED_FIELD,
            "No file provided",
            400,
            { field: "file" },
        );
    }

    return {
        filename,
        mimeType: contentType.split(";")[0]?.trim() ?? "",
        size,
    };
}

export function fileTooLarge(maxBytes: number): AppError {
    return new AppError(
        ErrorCode.FILE_TOO_LARGE,
        `File exceeds the ${formatUploadLimit(maxBytes)} size limit`,
        413,
        { maxBytes },
    );
}

export interface UploadStream {
    stream: Readable;
    /** Bytes read so far. */
    readonly bytes: number;
    /**
     * Why the stream failed, if the body broke the size contract. Storage
     * providers wrap stream errors in their own, so callers read it here.
     */
    readonly error: AppError | null;
}

/**
 * Stream the request body, failing as soon as it outgrows the declared
 * size, and at the end if it fell short of it (the client went away).
 */
export function streamUploadBody(
    body: ReadableStream<Uint8Array>,
    declaredSize: number,
): UploadStream {
    const state = {
        bytes: 0,
        error: null as AppError | null,
    };

    async function* chunks() {
        const reader = body.getReader();
        let done = false;
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) {
                    done = true;
                    break;
                }
                state.bytes += next.value.byteLength;
                if (state.bytes > declaredSize) {
                    state.error = new AppError(
                        ErrorCode.INVALID_INPUT,
                        "The upload was larger than it said it would be",
                        400,
                    );
                    throw state.error;
                }
                yield next.value;
            }
        } finally {
            // Stop the rest of the body arriving when reading ends early.
            if (!done) await reader.cancel().catch(() => {});
        }
        if (state.bytes < declaredSize) {
            state.error = new AppError(
                ErrorCode.INVALID_INPUT,
                "The upload was interrupted before the whole file arrived",
                400,
            );
            throw state.error;
        }
    }

    return {
        // objectMode off: consumers such as fs write streams want bytes.
        stream: Readable.from(chunks(), { objectMode: false }),
        get bytes() {
            return state.bytes;
        },
        get error() {
            return state.error;
        },
    };
}

/** Read a body that is small enough to hold in memory. */
export async function readUploadBody(
    body: ReadableStream<Uint8Array>,
    declaredSize: number,
): Promise<Buffer> {
    const upload = streamUploadBody(body, declaredSize);
    const chunks: Buffer[] = [];
    try {
        for await (const chunk of upload.stream) {
            chunks.push(chunk as Buffer);
        }
    } catch (error) {
        throw upload.error ?? error;
    }
    return Buffer.concat(chunks, upload.bytes);
}
