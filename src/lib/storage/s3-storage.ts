import type { Readable } from "node:stream";
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    type GetObjectCommandOutput,
    HeadBucketCommand,
    HeadObjectCommand,
    NotFound,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { resolveByteRange } from "./byte-range";
import {
    isRequestAbort,
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "./errors";
import { createReadBody } from "./read-body";
import type {
    RequestedByteRange,
    S3Config,
    StorageProvider,
    StorageRead,
} from "./types";

type S3ReadError = {
    name?: string;
    $metadata?: { httpStatusCode?: number };
    $response?: { headers: Record<string, string> };
    ActualObjectSize?: string;
};

class S3ReadMetadataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "S3ReadMetadataError";
    }
}

const MAX_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

function isObjectMissing(error: unknown): boolean {
    return (error as S3ReadError | null)?.name === "NoSuchKey";
}

function rangeHeader(range: RequestedByteRange | null): string | undefined {
    if (!range) return undefined;
    const offset = (value: bigint) => (value > MAX_OFFSET ? MAX_OFFSET : value);
    return "suffixLength" in range
        ? `bytes=-${offset(range.suffixLength)}`
        : `bytes=${offset(range.start)}-${range.end === null ? "" : offset(range.end)}`;
}

function isObjectSize(size: number | undefined): size is number {
    return size !== undefined && Number.isSafeInteger(size) && size >= 0;
}

function invalidRangeSize(error: S3ReadError): number | undefined {
    const header = error.$response?.headers["content-range"];
    const size =
        /^bytes \*\/(\d+)$/i.exec(header ?? "")?.[1] ?? error.ActualObjectSize;
    if (size === undefined || !/^\d+$/.test(size)) return undefined;
    const parsed = Number(size);
    return isObjectSize(parsed) ? parsed : undefined;
}

function emptyRead(): StorageRead {
    return {
        body: new ReadableStream({ start: (controller) => controller.close() }),
        totalSize: 0,
        range: null,
    };
}

/**
 * S3-compatible storage provider
 * Works with AWS S3, Cloudflare R2, MinIO, etc.
 */
export class S3Storage implements StorageProvider {
    private client: S3Client;
    private bucket: string;

    constructor(config: S3Config) {
        this.client = new S3Client({
            region: config.region,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey,
            },
            ...(config.endpoint && {
                endpoint: config.endpoint,
                forcePathStyle: true, // Required for some S3-compatible services
            }),
        });

        this.bucket = config.bucket;
    }

    async uploadFile(
        key: string,
        buffer: Buffer,
        contentType: string,
    ): Promise<string> {
        try {
            const command = new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: buffer,
                ContentType: contentType,
            });

            await this.client.send(command);
            return key;
        } catch (error) {
            throw new Error(
                `Failed to upload file to S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async downloadFile(key: string): Promise<Buffer> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });

            const response = await this.client.send(command);

            if (!response.Body) {
                throw new Error("Empty response body");
            }

            const chunks: Uint8Array[] = [];
            for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
                chunks.push(chunk);
            }
            return Buffer.concat(chunks);
        } catch (error) {
            if (isObjectMissing(error))
                throw new StorageObjectMissingError(error);
            throw new Error(
                `Failed to download file from S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async downloadStream(key: string): Promise<Readable> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });
            const response = await this.client.send(command);
            if (!response.Body) {
                throw new Error("Empty response body");
            }
            // Node runtime: Body is a Readable (not a web ReadableStream or Blob).
            return response.Body as Readable;
        } catch (error) {
            throw new Error(
                `Failed to stream download from S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async openRead(
        key: string,
        requested: RequestedByteRange | null,
        signal?: AbortSignal,
    ): Promise<StorageRead> {
        signal?.throwIfAborted();
        try {
            if (
                requested &&
                "suffixLength" in requested &&
                requested.suffixLength === BigInt(0)
            ) {
                throw new StorageRangeNotSatisfiableError(
                    await this.getObjectSize(key, signal),
                );
            }

            let response: GetObjectCommandOutput;
            try {
                response = await this.client.send(
                    new GetObjectCommand({
                        Bucket: this.bucket,
                        Key: key,
                        Range: rangeHeader(requested),
                    }),
                    { abortSignal: signal },
                );
            } catch (error) {
                if (signal && isRequestAbort(error, signal))
                    throw signal.reason;
                const failure = error as S3ReadError | null;
                if (
                    requested &&
                    (failure?.name === "InvalidRange" ||
                        failure?.$metadata?.httpStatusCode === 416)
                ) {
                    const size =
                        invalidRangeSize(failure) ??
                        (await this.getObjectSize(key, signal));
                    if (size === 0 && "suffixLength" in requested)
                        return emptyRead();
                    throw new StorageRangeNotSatisfiableError(size);
                }
                if (
                    requested &&
                    !signal?.aborted &&
                    failure?.name !== "AbortError" &&
                    !isObjectMissing(error)
                ) {
                    const size = await this.getObjectSize(key, signal).catch(
                        () => undefined,
                    );
                    if (isObjectSize(size)) resolveByteRange(requested, size);
                }
                throw error;
            }
            const source = response.Body as Readable | undefined;
            if (!source) throw new S3ReadMetadataError("Empty response body");

            try {
                signal?.throwIfAborted();
                const contentRange = requested
                    ? /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(
                          response.ContentRange ?? "",
                      )
                    : null;
                const objectSize = contentRange
                    ? Number(contentRange[3])
                    : undefined;
                if (requested && !isObjectSize(objectSize)) {
                    source.destroy();
                    const size = await this.getObjectSize(key, signal);
                    if (resolveByteRange(requested, size) === null)
                        return emptyRead();
                    throw new S3ReadMetadataError(
                        "S3 returned no usable Content-Range",
                    );
                }
                const totalSize = objectSize ?? response.ContentLength ?? null;
                if (totalSize !== null && !isObjectSize(totalSize))
                    throw new S3ReadMetadataError(
                        "S3 returned no usable object size",
                    );
                const range =
                    totalSize === null
                        ? null
                        : resolveByteRange(requested, totalSize);
                if (requested && range === null) {
                    source.destroy();
                    return emptyRead();
                }
                if (
                    contentRange &&
                    (!range ||
                        Number(contentRange[1]) !== range.start ||
                        Number(contentRange[2]) !== range.end)
                ) {
                    throw new S3ReadMetadataError(
                        "S3 returned an invalid Content-Range",
                    );
                }

                const iterator = (source as AsyncIterable<Uint8Array>)[
                    Symbol.asyncIterator
                ]();
                const body = createReadBody(
                    {
                        verifyEnd: true,
                        async read() {
                            const chunk = await iterator.next();
                            return chunk.done ? null : chunk.value;
                        },
                        close: () => {
                            source.destroy();
                        },
                        onError(fail) {
                            source.on("error", fail);
                            if (source.errored) fail(source.errored);
                        },
                    },
                    range ? range.end - range.start + 1 : totalSize,
                    signal,
                );
                return range && totalSize !== null
                    ? { body, totalSize, range }
                    : { body, totalSize, range: null };
            } catch (error) {
                if (!source.destroyed) source.destroy();
                throw error;
            }
        } catch (error) {
            if (signal && isRequestAbort(error, signal)) throw signal.reason;
            if (
                isObjectMissing(error) ||
                error instanceof StorageObjectMissingError
            ) {
                throw new StorageObjectMissingError();
            }
            if (
                error instanceof StorageRangeNotSatisfiableError ||
                error instanceof S3ReadMetadataError
            ) {
                throw error;
            }
            const failure = error as S3ReadError | null;
            const code = failure?.name;
            const status = failure?.$metadata?.httpStatusCode;
            const details: string[] = [];
            if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(code))
                details.push(code);
            if (
                typeof status === "number" &&
                Number.isInteger(status) &&
                status >= 100 &&
                status <= 599
            ) {
                details.push(`HTTP ${status}`);
            }
            const diagnosis =
                details.length > 0 ? ` (${details.join(", ")})` : "";
            throw new Error(`Failed to download file from S3${diagnosis}`);
        }
    }

    async getObjectSize(key: string, signal?: AbortSignal): Promise<number> {
        signal?.throwIfAborted();
        try {
            const { ContentLength } = await this.client.send(
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
                { abortSignal: signal },
            );
            if (ContentLength === undefined) {
                throw new Error("S3 HeadObject returned no ContentLength");
            }
            return ContentLength;
        } catch (error) {
            if (signal && isRequestAbort(error, signal)) throw signal.reason;
            if (isObjectMissing(error))
                throw new StorageObjectMissingError(error);
            const failure = error as S3ReadError | null;
            if (
                signal?.aborted ||
                failure?.name === "NoSuchBucket" ||
                (failure?.name !== "NotFound" &&
                    failure?.$metadata?.httpStatusCode !== 404)
            ) {
                throw error;
            }

            try {
                const { Body } = await this.client.send(
                    new GetObjectCommand({
                        Bucket: this.bucket,
                        Key: key,
                        Range: "bytes=0-0",
                    }),
                    { abortSignal: signal },
                );
                (Body as Readable | undefined)?.destroy();
            } catch (probeError) {
                if (isObjectMissing(probeError))
                    throw new StorageObjectMissingError(probeError);
                throw probeError;
            }
            throw error;
        }
    }

    async uploadStream(
        key: string,
        stream: Readable,
        contentType: string,
    ): Promise<string> {
        try {
            // lib-storage's Upload handles multipart automatically once the
            // stream crosses the part-size threshold, so archives of any
            // size stream straight through without buffering the whole
            // thing in server memory.
            const upload = new Upload({
                client: this.client,
                params: {
                    Bucket: this.bucket,
                    Key: key,
                    Body: stream,
                    ContentType: contentType,
                },
            });
            await upload.done();
            return key;
        } catch (error) {
            throw new Error(
                `Failed to stream upload to S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async exists(key: string): Promise<boolean> {
        try {
            await this.client.send(
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            );
            return true;
        } catch (error) {
            if (error instanceof NotFound) return false;
            // Some S3-compatible services return a generic 404 error that
            // isn't typed as NotFound -- treat any "not found"-shaped error
            // as missing rather than surfacing a hard failure here, since
            // this check exists purely to decide whether to skip a file.
            const status = (
                error as { $metadata?: { httpStatusCode?: number } }
            )?.$metadata?.httpStatusCode;
            if (status === 404) return false;
            throw error;
        }
    }

    async copyFile(sourceKey: string, destinationKey: string): Promise<string> {
        try {
            await this.client.send(
                new CopyObjectCommand({
                    Bucket: this.bucket,
                    CopySource: `${this.bucket}/${sourceKey}`,
                    Key: destinationKey,
                }),
            );
            return destinationKey;
        } catch (error) {
            throw new Error(
                `Failed to copy file in S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async getSignedUrl(key: string, expiresIn: number): Promise<string> {
        try {
            const command = new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });

            return await getSignedUrl(this.client, command, { expiresIn });
        } catch (error) {
            throw new Error(
                `Failed to generate signed URL: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async deleteFile(key: string): Promise<void> {
        try {
            const command = new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: key,
            });

            await this.client.send(command);
        } catch (error) {
            throw new Error(
                `Failed to delete file from S3: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    async testConnection(): Promise<boolean> {
        try {
            const command = new HeadBucketCommand({
                Bucket: this.bucket,
            });

            await this.client.send(command);
            return true;
        } catch {
            return false;
        }
    }
}
