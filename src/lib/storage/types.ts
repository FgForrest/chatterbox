import type { Readable } from "node:stream";

/** Inclusive byte offsets for a partial object read. */
export interface ByteRange {
    start: number;
    end: number;
}

/** A single HTTP byte range before it is resolved against the object size. */
export type RequestedByteRange =
    | { start: bigint; end: bigint | null }
    | { suffixLength: bigint };

/** Body and metadata from one storage read. Only a full read may have an unknown size. */
export type StorageRead = {
    body: ReadableStream<Uint8Array>;
} & (
    | { totalSize: number; range: ByteRange }
    | { totalSize: number | null; range: null }
);

/** Storage provider interface — implemented by local FS and S3-compatible. */
export interface StorageProvider {
    uploadFile(
        key: string,
        buffer: Buffer,
        contentType: string,
    ): Promise<string>;
    downloadFile(key: string): Promise<Buffer>;
    /**
     * Streaming read. Used by the export archive builder so a single
     * recording's audio is never fully buffered in server memory --
     * bytes flow straight from storage into the zip stream. Rejects
     * (or the returned stream emits `error`) if the key doesn't exist.
     */
    downloadStream(key: string): Promise<Readable>;
    /**
     * Opens the current object and streams the resolved interval or the full body.
     * Rejects with `StorageObjectMissingError`, `StorageRangeNotSatisfiableError`, or `signal.reason` on abort.
     * The body may error with `StorageObjectChangedError` if the object changes during the read.
     */
    openRead(
        key: string,
        range: RequestedByteRange | null,
        signal?: AbortSignal,
    ): Promise<StorageRead>;
    /** Returns the object's size in bytes. Rejects with StorageObjectMissingError for an absent key. */
    getObjectSize(key: string, signal?: AbortSignal): Promise<number>;
    /**
     * Streaming write. `contentLength` is a hint some backends (S3
     * multipart) can use but must not require -- callers may not know
     * the final size up front (e.g. a zip archive being built live).
     */
    uploadStream(
        key: string,
        stream: Readable,
        contentType: string,
    ): Promise<string>;
    /** Efficient server-side copy when the backend supports it. */
    copyFile?(sourceKey: string, destinationKey: string): Promise<string>;
    /** Cheap existence check, used to fail fast with a placeholder instead of starting a stream that will error partway through. */
    exists(key: string): Promise<boolean>;
    getSignedUrl(key: string, expiresIn: number): Promise<string>;
    deleteFile(key: string): Promise<void>;
    testConnection(): Promise<boolean>;
}

export interface S3Config {
    /** Optional for non-AWS S3-compatible services. */
    endpoint?: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export type StorageType = "local" | "s3";
