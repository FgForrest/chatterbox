import { Readable } from "node:stream";

function normalizeNewlines(value: string): string {
    return value.replace(/\r?\n|\r/g, "\r\n");
}

function escapedParameter(value: string): string {
    return normalizeNewlines(value)
        .replace(/\r/g, "%0D")
        .replace(/\n/g, "%0A")
        .replace(/"/g, "%22");
}

/** Yield a web stream's chunks, cancelling the stream when the consumer stops early. */
export async function* streamChunks(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield value;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}

/** Encode provider uploads as a bounded stream; Bun eagerly buffers FormData in Request. */
export function providerMultipartBody(form: FormData): {
    body: ReadableStream<Uint8Array>;
    contentType: string;
    contentLength: string;
} {
    const boundary = `----provider-${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const crlf = encoder.encode("\r\n");
    const end = encoder.encode(`--${boundary}--\r\n`);
    const parts = Array.from(form, ([name, value]) => {
        const disposition = `--${boundary}\r\nContent-Disposition: form-data; name="${escapedParameter(name)}"`;
        if (typeof value === "string") {
            return {
                header: encoder.encode(`${disposition}\r\n\r\n`),
                body: encoder.encode(normalizeNewlines(value)),
            };
        }
        return {
            header: encoder.encode(
                `${disposition}; filename="${escapedParameter(value.name)}"\r\nContent-Type: ${value.type || "application/octet-stream"}\r\n\r\n`,
            ),
            body: value,
        };
    });
    let length = end.byteLength;
    for (const { header, body } of parts) {
        length +=
            header.byteLength +
            crlf.byteLength +
            (body instanceof Uint8Array ? body.byteLength : body.size);
    }
    async function* chunks() {
        for (const { header, body } of parts) {
            yield header;
            if (body instanceof Uint8Array) yield body;
            else yield* streamChunks(body.stream());
            yield crlf;
        }
        yield end;
    }
    return {
        body: Readable.toWeb(
            Readable.from(chunks()),
        ) as ReadableStream<Uint8Array>,
        contentType: `multipart/form-data; boundary=${boundary}`,
        contentLength: String(length),
    };
}
