import {
    claimAgendaStream,
    releaseAgendaStream,
    renewAgendaStream,
} from "@/db/queries/agenda-events";
import { requireApiSession } from "@/lib/auth-server";
import { requireMeetingAccess } from "@/lib/meetings/access";
import { subscribeAgendaEvents } from "@/lib/meetings/events";
import { gateRecordingSessionRequest } from "@/lib/recording-sessions/route-gate";

/** Access-checked agenda invalidations with shared per-user capacity and periodic revocation. */
export async function agendaEventStream(
    request: Request,
    userId: string,
    id: string,
    recorder = false,
) {
    const { agenda } = await requireMeetingAccess(userId, id);
    const lease = await claimAgendaStream(userId);
    if (!lease)
        return Response.json(
            { error: "Too many agenda streams" },
            { status: 429, headers: { "Retry-After": "25" } },
        );
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            let closed = false;
            let checking = false;
            const write = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    cleanup();
                }
            };
            const unsubscribe = subscribeAgendaEvents(
                agenda.id,
                ({ cursor }) => {
                    write(
                        `data: ${JSON.stringify({ type: "agenda", cursor })}\n\n`,
                    );
                },
                {
                    ready: () =>
                        write(": connected\n\nevent: connected\ndata: {}\n\n"),
                    failed: () => cleanup(),
                },
            );
            const timer = setInterval(async () => {
                if (closed || checking) return;
                checking = true;
                try {
                    const principalId = recorder
                        ? (
                              await gateRecordingSessionRequest(request, {
                                  rateLimit: false,
                              })
                          ).authn?.user.id
                        : (await requireApiSession(request)).user.id;
                    if (principalId !== userId) {
                        cleanup();
                        return;
                    }
                    await requireMeetingAccess(userId, agenda.id);
                    if (!(await renewAgendaStream(userId, lease))) {
                        cleanup();
                        return;
                    }
                    write(": keep-alive\n\n");
                } catch {
                    cleanup();
                } finally {
                    checking = false;
                }
            }, 25_000);
            cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(timer);
                unsubscribe();
                request.signal.removeEventListener("abort", cleanup);
                void releaseAgendaStream(userId, lease).catch(() => {});
                try {
                    controller.close();
                } catch {}
            };
            request.signal.addEventListener("abort", cleanup, { once: true });
            if (request.signal.aborted) cleanup();
        },
        cancel() {
            cleanup();
        },
    });
    return new Response(stream, {
        headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
        },
    });
}
