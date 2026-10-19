"use client";

import { type ClientEvent, parseClientEvent } from "@/lib/events/types";

export type ConnectionState = "connecting" | "open" | "error" | "unavailable";
interface Subscriber {
    onEvent: (event: ClientEvent) => void;
    onState?: (state: ConnectionState) => void;
}

const subscribers = new Set<Subscriber>();
let source: EventSource | null = null;
let state: ConnectionState = "unavailable";

function setState(next: ConnectionState): void {
    state = next;
    for (const subscriber of subscribers) subscriber.onState?.(next);
}

/** Share one EventSource in this tab until its last subscriber leaves. */
export function subscribeEvents(
    onEvent: Subscriber["onEvent"],
    onState?: Subscriber["onState"],
): () => void {
    const subscriber = { onEvent, onState };
    subscribers.add(subscriber);
    if (!source && typeof EventSource !== "undefined") {
        try {
            source = new EventSource("/api/events");
            state = "connecting";
            source.onopen = () => setState("open");
            source.onerror = () => setState("error");
            source.onmessage = (message) => {
                const event = parseClientEvent(message.data);
                if (event)
                    for (const current of subscribers) current.onEvent(event);
            };
        } catch {
            state = "unavailable";
        }
    }
    onState?.(state);
    return () => {
        subscribers.delete(subscriber);
        if (subscribers.size === 0) {
            if (source) {
                source.onopen = null;
                source.onerror = null;
                source.onmessage = null;
                source.close();
                source = null;
            }
            state = "unavailable";
        }
    };
}
