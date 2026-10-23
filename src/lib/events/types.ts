export type OrgClientEvent =
    | { type: "tree" }
    | { type: "recording"; recordingId: string };

export type ClientEvent = OrgClientEvent | { type: "mail" } | { type: "share" };

/** Parse only the public invalidation frame shapes. */
export function parseClientEvent(data: string): ClientEvent | null {
    try {
        const value: unknown = JSON.parse(data);
        if (!value || typeof value !== "object" || Array.isArray(value))
            return null;
        const keys = Object.keys(value);
        if ("type" in value) {
            if (
                keys.length === 1 &&
                (value.type === "tree" ||
                    value.type === "mail" ||
                    value.type === "share")
            ) {
                return { type: value.type };
            }
            if (
                keys.length === 2 &&
                value.type === "recording" &&
                "recordingId" in value &&
                typeof value.recordingId === "string" &&
                value.recordingId.length > 0
            ) {
                return { type: "recording", recordingId: value.recordingId };
            }
        }
    } catch {}
    return null;
}
