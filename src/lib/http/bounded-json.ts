/**
 * A request's JSON body, read no further than `maxBytes` whatever its
 * length header says (a chunked body too): `tooLarge` past that, and
 * `body: undefined` for one that is not JSON.
 */
export async function readBoundedJson(
    request: Request,
    maxBytes: number,
): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
    const declared = Number(request.headers.get("content-length"));
    if (declared > maxBytes) return { tooLarge: true };
    if (!request.body) return { tooLarge: false, body: undefined };
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
            await reader.cancel().catch(() => {});
            return { tooLarge: true };
        }
        chunks.push(value);
    }
    try {
        return {
            tooLarge: false,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        };
    } catch {
        return { tooLarge: false, body: undefined };
    }
}
