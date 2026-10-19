import { EventEmitter } from "node:events";
import { sqlClient } from "@/db";
import { publishEvent } from "@/db/queries/events";
import { isMailEnabled } from "@/lib/mail/config";

interface PersonalEvent {
    type: "mail";
    userId: string;
}

const CHANNEL = "riffado_personal";
const emitter = new EventEmitter();
emitter.setMaxListeners(0);
let listening: Promise<unknown> | null = null;

/** Parse database notifications, rejecting foreign or malformed payloads. */
export function parsePersonalEvent(payload: string): PersonalEvent | null {
    try {
        const value: unknown = JSON.parse(payload);
        if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            Object.keys(value).length === 2 &&
            "type" in value &&
            value.type === "mail" &&
            "userId" in value &&
            typeof value.userId === "string" &&
            value.userId.length > 0
        ) {
            return { type: "mail", userId: value.userId };
        }
    } catch {}
    return null;
}

/** Best-effort invalidation, called only after mail acceptance commits. */
export async function notifyMailAccepted(userId: string): Promise<void> {
    if (!isMailEnabled()) return;
    try {
        await publishEvent(CHANNEL, { type: "mail", userId });
    } catch (error) {
        console.error("[personal-events] notify failed:", error);
    }
}

function ensureListening(): void {
    if (listening || !sqlClient) return;
    listening = sqlClient
        .listen(CHANNEL, (payload) => {
            const event = parsePersonalEvent(payload);
            if (event && isMailEnabled()) emitter.emit(`user:${event.userId}`);
        })
        .catch((error: unknown) => {
            console.error("[personal-events] listen failed:", error);
            listening = null;
        });
}

/** Subscribe only to this session user's personal invalidations. */
export function subscribePersonalEvents(
    userId: string,
    listener: () => void,
): () => void {
    if (!isMailEnabled()) return () => {};
    emitter.on(`user:${userId}`, listener);
    ensureListening();
    return () => {
        emitter.off(`user:${userId}`, listener);
    };
}
