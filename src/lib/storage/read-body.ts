import { StorageObjectChangedError } from "./errors";

type BodySource = {
    read(): Promise<Uint8Array | null>;
    close(): void | Promise<void>;
    onError?(fail: (error: unknown) => void): void;
    verifyEnd?: boolean;
};

class StorageBodyLengthError extends Error {}

const bodyErrorNames = new Set([
    "Error",
    "AbortError",
    "TimeoutError",
    "TypeError",
]);

function safeBodyError(error: unknown): Error {
    if (error instanceof StorageObjectChangedError) return error;
    const failure = new Error(
        error instanceof StorageBodyLengthError
            ? error.message
            : "Could not read the storage body",
    );
    if (error instanceof Error && bodyErrorNames.has(error.name)) {
        failure.name = error.name;
    }
    return failure;
}

/**
 * Streams a known length (`null` means unknown) and waits for EOF with `verifyEnd`.
 * Propagates source and length errors and releases the source once on close, cancel, or failure.
 */
export function createReadBody(
    source: BodySource,
    length: number | null,
    signal?: AbortSignal,
): ReadableStream<Uint8Array> {
    let remaining = length;
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;

    async function release() {
        if (closed) return;
        closed = true;
        signal?.removeEventListener("abort", abort);
        await source.close();
    }

    async function fail(error: unknown) {
        if (closed) return;
        if (signal?.aborted) {
            controller.error(signal.reason);
        } else {
            const failure = safeBodyError(error);
            const log =
                failure instanceof StorageObjectChangedError
                    ? console.warn
                    : console.error;
            log("[storage] Audio stream failed", failure.name, failure.message);
            controller.error(failure);
        }
        await release();
    }

    function abort() {
        void fail(signal?.reason).catch(() => {});
    }

    function expectsMoreFromSource(): boolean {
        return remaining !== 0 || source.verifyEnd === true;
    }

    return new ReadableStream(
        {
            start(streamController) {
                controller = streamController;
                signal?.addEventListener("abort", abort, { once: true });
                source.onError?.((error) => {
                    void fail(error).catch(() => {});
                });
                if (signal?.aborted) abort();
            },
            async pull() {
                try {
                    if (expectsMoreFromSource()) {
                        const chunk = await source.read();
                        if (closed) return;
                        if (chunk === null) {
                            if (remaining !== null && remaining !== 0) {
                                throw new StorageBodyLengthError(
                                    "Storage body ended before the promised length",
                                );
                            }
                        } else {
                            if (remaining !== null) {
                                remaining -= chunk.byteLength;
                                if (remaining < 0) {
                                    throw new StorageBodyLengthError(
                                        "Storage body exceeds the promised length",
                                    );
                                }
                            }
                            controller.enqueue(chunk);
                            if (expectsMoreFromSource()) return;
                        }
                    }
                    controller.close();
                    await release();
                } catch (error) {
                    await fail(error);
                }
            },
            cancel: release,
        },
        { highWaterMark: 0 },
    );
}
