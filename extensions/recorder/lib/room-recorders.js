import { lookupRoomRecorders } from "./api.js";
import { meetingRoom } from "./meeting-room.js";
import { sameConnection } from "./server-connection.js";
import { getSettings } from "./settings.js";

const CACHE_MS = 30_000;
const BACKOFF_KEY = "roomRecorderBackoff";

/** Convert monotonic time to a timestamp comparable across extension contexts. */
export function roomRecorderClock() {
    return performance.timeOrigin + performance.now();
}

/** Use room presence only for a consenting pairing whose cached config advertises it. */
export function supportsRoomRecorders(settings) {
    return Boolean(settings.dataUseAcknowledgedAt && settings.serverUrl && settings.hasApiKey &&
        settings.serverDefaults?.roomRecorders === 1);
}

/** Match the cached room capability and the pairing it belongs to. */
export function sameRoomPairing(a, b) {
    return sameConnection(a, b) && a.accountId === (b.accountId ?? b.serverDefaults?.accountId ?? null);
}

/** Detect a change that invalidates room lookups and their displayed names. */
export function roomPairingChanged(changes) {
    const { oldValue, newValue } = changes.serverDefaults ?? {};
    return Boolean(changes.serverUrl || changes.encryptedApiKey || changes.dataUseAcknowledgedAt ||
        oldValue?.accountId !== newValue?.accountId || oldValue?.roomRecorders !== newValue?.roomRecorders);
}

/** Cache one room result per active tab and fence it against navigation and pairing changes. */
export function createRoomRecorderLookup({ authFor, isIdle }) {
    const tabs = new Map();
    let generation = 0;
    let backoff;

    async function current(entry) {
        const [settings, tab, idle] = await Promise.all([
            getSettings(), chrome.tabs.get(entry.tabId).catch(() => null), isIdle(),
        ]);
        return tabs.get(entry.tabId) === entry && idle && supportsRoomRecorders(settings) &&
            sameRoomPairing(entry, settings) && tab?.active === true && meetingRoom(tab.url) === entry.room;
    }

    async function backoffFor(entry) {
        if (!backoff) {
            const stored = (await chrome.storage.session.get(BACKOFF_KEY))[BACKOFF_KEY];
            backoff ??= stored ?? {};
        }
        const stored = backoff;
        return sameRoomPairing(entry, stored) ? stored.until : 0;
    }

    async function load(entry, settings) {
        try {
            if ((await backoffFor(entry)) > Date.now()) return [];
            const auth = await authFor(settings);
            if (!(await current(entry)) || (await backoffFor(entry)) > Date.now() ||
                tabs.get(entry.tabId) !== entry) return [];
            const startedAt = roomRecorderClock();
            const { names, freshForMs } = await lookupRoomRecorders(auth, entry.room);
            if (!names.length || !Number.isFinite(freshForMs)) return [];
            entry.expiresAt = startedAt + Math.min(CACHE_MS, freshForMs);
            return names;
        } catch (error) {
            if ((error?.status ?? error?.httpStatus) === 429 && entry.generation === generation) {
                const until = Date.now() + Math.max(CACHE_MS, (error.retryAfterSeconds ?? 60) * 1000);
                const previous = await backoffFor(entry);
                if (entry.generation === generation && !(previous > until)) {
                    const { serverUrl, connectionId, accountId } = entry;
                    backoff = { serverUrl, connectionId, accountId, until };
                    await chrome.storage.session.set({ [BACKOFF_KEY]: backoff }).catch(() => {});
                }
            }
            return [];
        }
    }

    return {
        async get(tabId) {
            const requested = generation;
            const [settings, tab, idle] = await Promise.all([
                getSettings(), chrome.tabs.get(tabId).catch(() => null), isIdle(),
            ]);
            const room = meetingRoom(tab?.url);
            if (requested !== generation || !idle || !room || tab?.active !== true ||
                !supportsRoomRecorders(settings)) return {};
            const pairing = {
                serverUrl: settings.serverUrl, connectionId: settings.connectionId,
                accountId: settings.serverDefaults?.accountId ?? null,
            };
            if ((await backoffFor(pairing)) > Date.now() || requested !== generation) return {};
            let entry = tabs.get(tabId);
            if (!entry || entry.room !== room || !sameRoomPairing(entry, settings) || entry.expiresAt <= roomRecorderClock()) {
                entry = {
                    tabId, room, generation, expiresAt: roomRecorderClock() + CACHE_MS,
                    ...pairing,
                };
                tabs.set(tabId, entry);
                entry.names = load(entry, settings);
            }
            const names = await entry.names;
            if (await current(entry) && !((await backoffFor(entry)) > Date.now()) &&
                tabs.get(tabId) === entry && entry.expiresAt > roomRecorderClock()) {
                return { names, expiresAt: entry.expiresAt };
            }
            return {};
        },
        invalidate(tabId) {
            tabs.delete(tabId);
        },
        invalidatePairing() {
            generation++;
            tabs.clear();
            backoff = {};
            void chrome.storage.session.remove(BACKOFF_KEY).catch(() => {});
        },
    };
}
