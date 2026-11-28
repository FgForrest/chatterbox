import { AUDIO_BITS_PER_SECOND, MAX_CAPTURE_CHUNKS } from "./constants.js";

const persistenceKey = "recorderStoragePersistence";
const hourOfAudio = AUDIO_BITS_PER_SECOND * 3600 / 8;

/** Request persistence once per profile and retain the browser's current answer. */
export async function rememberCapturePersistence() {
    const storage = globalThis.navigator?.storage;
    if (!storage?.persisted || !storage.persist) return;
    const save = async () => {
        const previous = (await chrome.storage.local.get(persistenceKey))[persistenceKey];
        if (!previous?.requested) {
            await chrome.storage.local.set({ [persistenceKey]: { requested: true } });
            await storage.persist().catch(() => false);
        }
        await chrome.storage.local.set({
            [persistenceKey]: { requested: true, persisted: await storage.persisted() },
        });
    };
    if (navigator.locks) await navigator.locks.request(persistenceKey, save);
    else await save();
}

/** Check available space without making quota estimates a condition of capture. */
export async function lowCaptureStorage() {
    const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => null);
    return Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage) &&
        estimate.quota - estimate.usage < hourOfAudio;
}

/** Check an emitted envelope against the server's byte and index limits. */
export function exceedsCaptureLimits(index, bytes, maxSessionBytes) {
    return index >= MAX_CAPTURE_CHUNKS || bytes > maxSessionBytes;
}
