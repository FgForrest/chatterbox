import { z } from "zod";
import { AppError, ErrorCode } from "@/lib/errors";
import { meetingRoute } from "@/lib/meetings/route";
import { getAgendaText, updateAgendaText } from "@/lib/meetings/text-documents";

const input = z.object({
    field: z.string().min(1).max(270),
    update: z.string().max(87384),
    stateVector: z.string().max(10924).optional(),
});

/** Share the identical text protocol between session and recorder authentication. */
export function agendaTextRoutes(recorder = false) {
    return {
        GET: meetingRoute(
            ({ userId, params, url }) =>
                getAgendaText(
                    userId,
                    params.id,
                    z
                        .string()
                        .min(1)
                        .max(270)
                        .parse(url.searchParams.get("field")),
                ),
            recorder,
        ),
        POST: meetingRoute(async ({ userId, params, request }) => {
            if (Number(request.headers.get("content-length")) > 100_000)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Agenda text update too large",
                    413,
                );
            const reader = request.body?.getReader();
            if (!reader)
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid agenda text update",
                    400,
                );
            let size = 0;
            const chunks: Uint8Array[] = [];
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > 100_000) {
                        await reader.cancel();
                        throw new AppError(
                            ErrorCode.INVALID_INPUT,
                            "Agenda text update too large",
                            413,
                        );
                    }
                    chunks.push(value);
                }
            } finally {
                reader.releaseLock();
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }
            let body: unknown;
            try {
                body = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                throw new AppError(
                    ErrorCode.INVALID_INPUT,
                    "Invalid agenda text update",
                    400,
                );
            }
            return updateAgendaText(userId, params.id, input.parse(body));
        }, recorder),
    };
}
