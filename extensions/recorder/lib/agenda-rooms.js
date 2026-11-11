import { meetCode } from "./meet-code.js";
import { supportsAgendas } from "./agendas.js";

/** Room features are opt-in for each paired server. */
export function supportsAgendaRooms(settings) {
    return supportsAgendas(settings) && settings.serverDefaults?.agendaRooms === 1;
}

/** A recording declares only a validated code, never its source URL. */
export function sessionRoom(settings, tab) {
    const code = supportsAgendaRooms(settings) ? meetCode(tab?.url) : null;
    return code ? { meetCode: code } : {};
}

/** Keep presence tied to the panel document, with retry timing supplied by the server. */
export function panelRoomHeartbeat(send) {
    let timer;
    let current;
    let signature;
    let stopped = false;
    let running = false;
    let pending = false;
    async function beat() {
        clearTimeout(timer);
        if (stopped || !current) return;
        if (running) { pending = true; return; }
        const sent = current;
        running = true;
        let delay = 60000;
        try {
            const response = await send({ type: "room-presence", ...sent });
            if (response?.retryAfterMs > 0) delay = Math.max(1000, response.retryAfterMs);
        } catch {}
        finally {
            running = false;
            if (stopped || !current) return;
            if (pending) { pending = false; void beat(); }
            else timer = setTimeout(beat, delay);
        }
    }
    return {
        update(settings, tab, agendaId) {
            const code = supportsAgendaRooms(settings) ? meetCode(tab?.url) : null;
            const next = code ? { tabId: tab.id, roomCode: code, agendaId: agendaId ?? null } : null;
            const key = code ? JSON.stringify([settings.serverUrl, settings.connectionId, code, next]) : null;
            if (key === signature) return;
            signature = key;
            current = next;
            clearTimeout(timer);
            if (current) void beat();
        },
        stop() { stopped = true; current = null; clearTimeout(timer); },
    };
}
