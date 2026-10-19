import { t } from "./i18n.js";

export const MICROPHONE_GRANT_KEY = "microphoneGrantAt";
const GRANT_LIFETIME_MS = 5 * 60 * 1000;

/** Read the current Chrome microphone permission for this extension origin. */
export async function microphonePermission() {
    let state = "unknown";
    try {
        const permission = await navigator.permissions.query({
            name: "microphone",
        });
        state = permission.state;
    } catch {}
    if (["granted", "prompt", "denied"].includes(state)) {
        if (state !== "granted")
            await chrome.storage.session.remove(MICROPHONE_GRANT_KEY).catch(() => {});
        return state;
    }
    const stored = await chrome.storage.session.get(MICROPHONE_GRANT_KEY);
    const age = Date.now() - stored[MICROPHONE_GRANT_KEY];
    return age >= 0 && age < GRANT_LIFETIME_MS ? "granted" : "unknown";
}

/** Ask from a visible extension page and release the test stream immediately. */
export async function requestMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    await chrome.storage.session.set({ [MICROPHONE_GRANT_KEY]: Date.now() });
}

/** Localized reason, including browsers whose DOMException message is empty. */
export function microphoneError(name) {
    const keys = {
        OverconstrainedError: "micDeviceMissing",
        NotFoundError: "micDeviceMissing",
        NotReadableError: "micDeviceBusy",
        NotAllowedError: "micDeviceBlocked",
        SecurityError: "micDeviceBlocked",
        AbortError: "micDeviceAborted",
        TrackEnded: "micDeviceEnded",
    };
    return t(keys[name] ?? "micDeviceFailed");
}
