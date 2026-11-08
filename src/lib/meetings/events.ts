import { EventEmitter } from "node:events";
import { openAgendaListener } from "@/db/queries/agenda-listener";

export interface AgendaEvent {
    agendaId: string;
    cursor: string;
}
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let listening: Promise<unknown> | null = null;
const subscribers = new Set<{ ready: () => void; failed: () => void }>();
let closeListener: (() => void) | undefined;
let generation = 0;
let retryAt = 0;
let attempts = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function ensureListening() {
    if (listening || !subscribers.size) return;
    clearTimeout(retryTimer);
    if (Date.now() < retryAt) {
        retryTimer = setTimeout(ensureListening, retryAt - Date.now());
        return;
    }
    const current = ++generation;
    const fail = () => {
        if (current !== generation) return;
        generation++;
        closeListener?.();
        closeListener = undefined;
        listening = null;
        retryAt =
            Date.now() + Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5));
        for (const subscriber of [...subscribers]) subscriber.failed();
        ensureListening();
    };
    listening = openAgendaListener((payload) => {
        const event = parseAgendaEvent(payload);
        if (event && current === generation)
            emitter.emit(event.agendaId, event);
    }, fail).then((close) => {
        if (current !== generation) {
            close();
            return;
        }
        closeListener = close;
        attempts = 0;
        for (const subscriber of [...subscribers]) subscriber.ready();
    }, fail);
}

/** Reject content-bearing and malformed notifications before fan-out. */
export function parseAgendaEvent(payload: string): AgendaEvent | null {
    try {
        const value: unknown = JSON.parse(payload);
        if (
            value &&
            typeof value === "object" &&
            Object.keys(value).length === 2 &&
            "agendaId" in value &&
            typeof value.agendaId === "string" &&
            value.agendaId.length > 0 &&
            value.agendaId.length <= 255 &&
            "cursor" in value &&
            typeof value.cursor === "string" &&
            /^\d+$/.test(value.cursor)
        )
            return { agendaId: value.agendaId, cursor: value.cursor };
    } catch {}
    return null;
}

/** Fan out one database LISTEN per process to agenda-specific subscribers. */
export function subscribeAgendaEvents(
    agendaId: string,
    listener: (event: AgendaEvent) => void,
    lifecycle = { ready: () => {}, failed: () => {} },
): () => void {
    emitter.on(agendaId, listener);
    subscribers.add(lifecycle);
    if (closeListener)
        queueMicrotask(() => {
            if (subscribers.has(lifecycle)) lifecycle.ready();
        });
    ensureListening();
    return () => {
        emitter.off(agendaId, listener);
        subscribers.delete(lifecycle);
        if (!subscribers.size) {
            generation++;
            clearTimeout(retryTimer);
            closeListener?.();
            closeListener = undefined;
            listening = null;
        }
    };
}
