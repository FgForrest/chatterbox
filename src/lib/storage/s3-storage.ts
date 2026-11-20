import type { Readable } from "node:stream";
import {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadBucketCommand,
    HeadObjectCommand,
    NotFound,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
    StorageObjectMissingError,
    StorageRangeNotSatisfiableError,
} from "./errors";
import type {
    ByteRange,
    RangedDownload,
    S3Config,
    StorageProvider,
} from "./types";

type S3ReadError = { name?: string; $metadata?: { httpStatusCode?: number } };

function isObjectMissing(error: unknown): boolean {
    return (error as S3ReadError | null)?.name === "NoSuchKey";
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

    async downloadRange(
        key: string,
        range: ByteRange,
    ): Promise<RangedDownload> {
        try {
            const response = await this.client.send(
                new GetObjectCommand({
                    Bucket: this.bucket,
                    Key: key,
                    Range: `bytes=${range.start}-${range.end}`,
                }),
            );
            const body = response.Body as Readable | undefined;
            if (!body) throw new Error("Empty response body");

            try {
                const contentRange = /^bytes (\d+)-(\d+)\/(\d+)$/i.exec(
                    response.ContentRange ?? "",
                );
                if (!contentRange)
                    throw new Error("S3 returned no usable Content-Range");
                const [, first, last, total] = contentRange;
                const [start, end, totalSize] = [
                    Number(first),
                    Number(last),
                    Number(total),
                ];
                if (
                    !Number.isSafeInteger(totalSize) ||
                    start !== range.start ||
                    end < start ||
                    end > range.end ||
                    end >= totalSize
                ) {
                    throw new Error("S3 returned an invalid Content-Range");
                }

                const data = Buffer.alloc(end - start + 1);
                let offset = 0;
                for await (const chunk of body as AsyncIterable<Uint8Array>) {
                    if (chunk.byteLength > data.length - offset) {
                        throw new Error("S3 body exceeds Content-Range");
                    }
                    data.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                if (offset !== data.length)
                    throw new Error("S3 body ended before Content-Range");
                return { data, totalSize };
            } finally {
                body.destroy();
            }
        } catch (error) {
            if (isObjectMissing(error))
                throw new StorageObjectMissingError(error);
            const failure = error as S3ReadError | null;
            if (
                failure?.name === "InvalidRange" ||
                failure?.$metadata?.httpStatusCode === 416
            ) {
                throw new StorageRangeNotSatisfiableError(
                    await this.getObjectSize(key),
                );
            }
            throw error;
        }
    }

    async getObjectSize(key: string): Promise<number> {
        try {
            const { ContentLength } = await this.client.send(
                new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
            );
            if (ContentLength === undefined) {
                throw new Error("S3 HeadObject returned no ContentLength");
            }
            return ContentLength;
        } catch (error) {
            if (isObjectMissing(error))
                throw new StorageObjectMissingError(error);
            const failure = error as S3ReadError | null;
            if (
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
