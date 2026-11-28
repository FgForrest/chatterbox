import { postRecordingLease } from "./api.js";
import { serverSessionFor, updateCapture } from "./capture-state.js";
import { readLocalMeta } from "./chunk-store.js";
import { meetingRoom } from "./meeting-room.js";
import { sameRoomPairing, supportsRoomRecorders } from "./room-recorders.js";
import { getSettings } from "./settings.js";

const RENEW_MS = 20_000;

function canRenew(meta, sessionId) {
    const lease = meta?.lease;
    const current = lease && (!lease.sessionId || lease.sessionId === sessionId) ? lease : null;
    return meta && !meta.stoppedAt && !meta.stopRequestedAt && !meta.lease?.ended &&
        !current?.refused && meta.serverSessionId === sessionId &&
        Date.now() >= (current?.attemptedAt ?? -Infinity) + RENEW_MS;
}

/** Renew on confirmed chunks from a live tab capture and end independently of audio upload. */
export function createCaptureLeases({ liveCapture, ping, authFor }) {
    const renewing = new Map();
    const ending = new Map();

    async function currentAuth(meta, settings, auth) {
        const current = await getSettings();
        return supportsRoomRecorders(current) && sameRoomPairing({
            ...auth,
            accountId: settings.serverDefaults?.accountId ?? null,
        }, current) && meta.pairing?.connectionId === current.connectionId;
    }

    async function renew(captureId, attempt) {
        const settings = await getSettings();
        if (!supportsRoomRecorders(settings)) return;
        const state = await liveCapture(captureId);
        if (!state) return;
        const meta = await readLocalMeta(captureId);
        if (!canRenew(meta, state.sessionId) || meta.pairing?.connectionId !== settings.connectionId) return;
        const tab = await chrome.tabs.get(state.tabId).catch(() => null);
        if (!tab || (!meetingRoom(tab.url) && (!meta.lease || meta.lease.inRoom === false))) return;
        const auth = await authFor(meta, settings);
        const host = await ping(state);
        if (host?.captureId !== captureId || host.recording !== true || attempt.cancelled) return;
        let revision;
        const saved = await updateCapture(captureId, (current) => {
            if (attempt.cancelled || !canRenew(current, state.sessionId)) return null;
            revision = (current.lease?.revision ?? 0) + 1;
            return { lease: { sessionId: state.sessionId, revision, attemptedAt: Date.now() } };
        });
        if (!saved || revision === undefined) return;
        const [latestTab, current, paired] = await Promise.all([
            chrome.tabs.get(state.tabId).catch(() => null), liveCapture(captureId),
            currentAuth(saved, settings, auth),
        ]);
        if (attempt.cancelled || !paired || current?.sessionId !== state.sessionId ||
            current.tabId !== state.tabId || !latestTab) return;
        const room = meetingRoom(latestTab.url);
        if (!room && !meta.lease) return;
        const ownsLease = (latest) => latest.serverSessionId === state.sessionId &&
            latest.lease?.sessionId === state.sessionId && latest.lease.revision === revision && !latest.lease.ended;
        try {
            await postRecordingLease(auth, state.sessionId, revision, room);
            if (!room) await updateCapture(captureId, (latest) => ownsLease(latest)
                ? { lease: { ...latest.lease, inRoom: false } }
                : null);
        } catch (error) {
            if (error?.code === "RECORDING_LEASE_REFUSED") {
                await updateCapture(captureId, (latest) => ownsLease(latest)
                    ? { lease: { ...latest.lease, refused: true } } : null);
            }
        }
    }

    async function end(captureId) {
        let reserved = false;
        const meta = await updateCapture(captureId, (current) => {
            if (!current.lease || current.lease.ended) return null;
            reserved = current.lease.attemptedAt !== undefined;
            return { lease: { ...current.lease, revision: current.lease.revision + 1, ended: true } };
        });
        if (!reserved) return;
        const sessionId = serverSessionFor(meta, captureId);
        const settings = await getSettings();
        if (!sessionId || !supportsRoomRecorders(settings) || meta.pairing?.connectionId !== settings.connectionId) return;
        const auth = await authFor(meta, settings);
        if (await currentAuth(meta, settings, auth)) await postRecordingLease(auth, sessionId, meta.lease.revision);
    }

    return {
        async chunk(captureId) {
            if (renewing.has(captureId) || ending.has(captureId)) return;
            const attempt = { cancelled: false };
            renewing.set(captureId, attempt);
            try {
                await renew(captureId, attempt);
            } catch {} finally {
                renewing.delete(captureId);
            }
        },
        end(captureId) {
            if (!captureId || ending.has(captureId)) return;
            const attempt = renewing.get(captureId);
            if (attempt) attempt.cancelled = true;
            const work = end(captureId).catch(() => {}).finally(() => ending.delete(captureId));
            ending.set(captureId, work);
        },
    };
}
