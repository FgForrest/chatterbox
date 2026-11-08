import { pairingRequest } from "./pairing-request-auth.js";
import { supportsAgendas } from "./agendas.js";
import { getSettings } from "./settings.js";

/** Keep an authenticated agenda stream alive only in its visible extension page. */
export function subscribeAgenda(id, { invalidate, onConnection = () => {} }) {
    let destroyed = false;
    let timer;
    let controller;
    let attempt = 0;
    async function connect() {
        controller = new AbortController();
        let retry = 0;
        try {
            const settings = await getSettings();
            if (
                destroyed ||
                !supportsAgendas(settings) ||
                settings.serverDefaults?.agendaLive !== true
            )
                return;
            const response = await pairingRequest(
                `/api/v1/recorder/agendas/${encodeURIComponent(id)}/events`,
                { signal: controller.signal },
                (value) => !destroyed && supportsAgendas(value) && value.serverDefaults?.agendaLive === true,
                settings,
            );
            if (destroyed) return;
            if (
                !response.body ||
                !response.headers
                    .get("content-type")
                    ?.includes("text/event-stream")
            )
                throw new Error("Invalid stream");
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                while (!destroyed) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder
                        .decode(value, { stream: true })
                        .replace(/\r\n/g, "\n");
                    if (buffer.length > 65536)
                        throw new Error("Invalid stream frame");
                    let end;
                    while ((end = buffer.indexOf("\n\n")) !== -1) {
                        const frame = buffer.slice(0, end);
                        buffer = buffer.slice(end + 2);
                        if (frame.split("\n").includes(": connected")) {
                            attempt = 0;
                            onConnection(true);
                            await invalidate();
                        }
                        const data = frame
                            .split("\n")
                            .filter((line) => line.startsWith("data:"))
                            .map((line) => line.slice(5).trim())
                            .join("\n");
                        if (!data) continue;
                        const event = JSON.parse(data);
                        if (event.type === "agenda") {
                            attempt = 0;
                            await invalidate();
                        }
                    }
                }
            } finally {
                await reader.cancel().catch(() => {});
                reader.releaseLock();
            }
        } catch (error) {
            if ([401, 403, 404, 410].includes(error?.status)) {
                onConnection(false);
                return;
            }
            retry = (error?.retryAfterSeconds ?? 0) * 1000;
        } finally {
            onConnection(false);
        }
        if (!destroyed)
            timer = setTimeout(
                () => void connect(),
                Math.max(
                    retry,
                    Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)),
                ),
            );
    }
    void connect();
    return () => {
        destroyed = true;
        clearTimeout(timer);
        controller?.abort();
        onConnection(false);
    };
}
