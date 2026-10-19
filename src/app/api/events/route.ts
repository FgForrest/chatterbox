import { requireApiSession } from "@/lib/auth-server";
import { apiHandler } from "@/lib/errors";
import { subscribePersonalEvents } from "@/lib/events/personal";
import { getOrgUserId } from "@/lib/org/config";
import { type OrgEvent, subscribeOrgEvents } from "@/lib/org/events";

export const dynamic = "force-dynamic";

const KEEPALIVE_MS = 25_000;

/** Stream the viewer's personal and configured Organization invalidations. */
export const GET = apiHandler(async (request: Request) => {
    const session = await requireApiSession(request);
    const hasOrg = Boolean(await getOrgUserId());

    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream({
        start(controller) {
            let closed = false;
            const write = (chunk: string) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    closed = true;
                    cleanup();
                }
            };
            const unsubscribeOrg = hasOrg
                ? subscribeOrgEvents((event: OrgEvent) => {
                      write(`data: ${JSON.stringify(event)}\n\n`);
                  })
                : () => {};
            const unsubscribePersonal = subscribePersonalEvents(
                session.user.id,
                () => {
                    write('data: {"type":"mail"}\n\n');
                },
            );
            const keepalive = setInterval(
                () => write(": keep-alive\n\n"),
                KEEPALIVE_MS,
            );
            cleanup = () => {
                closed = true;
                clearInterval(keepalive);
                unsubscribeOrg();
                unsubscribePersonal();
                request.signal.removeEventListener("abort", cleanup);
                try {
                    controller.close();
                } catch {
                    // Already closed by the client.
                }
            };
            request.signal.addEventListener("abort", cleanup, { once: true });
            if (request.signal.aborted) cleanup();
            write(": connected\n\n");
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
});
