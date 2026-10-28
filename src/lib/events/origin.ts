export const EVENT_ORIGIN_HEADER = "x-chatterbox-event-origin";

/** Read an optional event label; it grants no access or permissions. */
export function readEventOrigin(headers: Headers): string | undefined {
    const value = headers.get(EVENT_ORIGIN_HEADER);
    return value && /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : undefined;
}
