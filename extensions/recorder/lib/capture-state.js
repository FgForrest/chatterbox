import {
    createLocalSession,
    deleteLocalSession,
    discardLocalAudio,
    listChunkIndices,
    listLocalSessions,
    readLocalMeta,
    writeCaptureStop,
} from "./chunk-store.js";

const operations = new Map();
const writes = new Map();

function enqueue(queues, captureId, change) {
    const operation = (queues.get(captureId) ?? Promise.resolve()).catch(() => {}).then(change);
    queues.set(captureId, operation);
    return operation.finally(() => {
        if (queues.get(captureId) === operation) queues.delete(captureId);
    });
}

/** Keep capture creation and pairing replacement atomic across extension contexts. */
export function withPairingBinding(change) {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request("recorder:pairing", change) : change();
}

/** Find the create intent in a released server's session list. */
export function sessionForIntent(sessions, intent) {
    return sessions.find((row) =>
        row.metadata?.clientVersion === intent.clientVersion &&
        Date.parse(row.started_at) === Date.parse(intent.startedAt));
}

/** Serialize lifecycle changes to one immutable capture ID in the worker. */
export function withCapture(captureId, change) {
    return enqueue(operations, captureId, change);
}

/** Patch existing metadata without recreating a deleted capture. */
export function updateCapture(captureId, patch, isCurrent = () => true) {
    return enqueue(writes, captureId, async () => {
        const meta = await readLocalMeta(captureId);
        if (!meta || meta.cleanupPending || !(await isCurrent())) return null;
        const value = typeof patch === "function" ? await patch(meta) : patch;
        if (!value) return meta;
        const next = { ...meta, ...value };
        await createLocalSession(captureId, next, { create: false });
        return next;
    });
}

/** Remove a capture after outstanding metadata writes have closed. */
export function deleteCapture(captureId) {
    return enqueue(writes, captureId, () => deleteLocalSession(captureId));
}

/** Create a durable capture before requesting a server session. */
export async function createCapture({
    clientRecordingId = crypto.randomUUID(),
    startedAt = new Date().toISOString(),
    pairing = null,
    protocol = 1,
    ...input
}) {
    const captureId = crypto.randomUUID();
    const meta = {
        ...input,
        captureId,
        clientRecordingId,
        startedAt,
        pairing,
        protocol,
        sealing: null,
        serverSessionId: null,
        stoppedAt: null,
        verifiedPrefix: -1,
        highestCommittedIndex: -1,
        createIntent: input.createIntent ?? null,
        createOutcome: null,
        completeIntent: null,
    };
    await createLocalSession(captureId, meta);
    return meta;
}

/** Attach a server binding inside the capture lifecycle queue. */
export function attachSession(captureId, serverSessionId, patch = {}) {
    return updateCapture(captureId, (meta) => {
        const lease = meta.lease;
        return { ...patch, serverSessionId, createOutcome: "attached",
            ...(lease && meta.serverSessionId !== serverSessionId && {
                lease: { revision: lease.revision, ...(lease.ended && { ended: true }) },
            }),
        };
    });
}

/** Keep only the details needed to cancel a discarded sealed capture. */
export function retainCaptureCleanup(captureId) {
    return enqueue(writes, captureId, async () => {
        const meta = await readLocalMeta(captureId);
        if (!meta) return null;
        if (!meta.cleanupPending && !meta.serverSessionId && meta.createOutcome !== "unknown") {
            await deleteLocalSession(captureId);
            return null;
        }
        const { protocol, pairing, serverUrl, serverSessionId, sealing, createIntent, clientRecordingId } = meta;
        const cleanup = { captureId, protocol, pairing, serverUrl, serverSessionId, sealing, createIntent,
            clientRecordingId, cleanupPending: true, cleanupStep: serverSessionId ? "cancel" : "resolve" };
        await discardLocalAudio(captureId, cleanup);
        return cleanup;
    });
}

/** Keep the resolved session across cleanup attempts. */
export function resolveCaptureCleanup(captureId, sessionId) {
    return enqueue(writes, captureId, async () => {
        const meta = await readLocalMeta(captureId);
        if (!meta?.cleanupPending) return null;
        const next = { ...meta, serverSessionId: sessionId, cleanupStep: "cancel" };
        await createLocalSession(captureId, next, { create: false });
        return next;
    });
}

/** Session-storage key for the selected agenda's display title. */
export function captureAgendaTitleKey(captureId) {
    return `recorder-capture-agenda:${captureId}`;
}

/** Highest contiguous index present locally or acknowledged by the server. */
export function verifiedPrefix(indices, acknowledged = [], previous = -1) {
    const available = new Set([...indices, ...acknowledged]);
    let index = previous + 1;
    while (available.has(index)) index++;
    return index - 1;
}

/** Seal the verified prefix and preserve the first persisted stop time. */
export async function markStopped(captureId, { stoppedAt, stopReason, chunkCount, uploaded }) {
    const meta = await readLocalMeta(captureId);
    if (!meta) return null;
    const stored = await listChunkIndices(captureId, true);
    const prefix = verifiedPrefix(stored, uploaded);
    const highestCommittedIndex = Math.max(meta.highestCommittedIndex ?? -1, meta.verifiedPrefix ?? -1, ...stored, ...(uploaded ?? []));
    const stop = {
        stoppedAt: meta.stoppedAt ?? stoppedAt ?? meta.stopRequestedAt ?? new Date().toISOString(),
        stopReason,
        chunkCount: Math.max(chunkCount ?? 0, (meta.stoppedAt ? meta.chunkCount : 0) ?? 0, highestCommittedIndex + 1),
        verifiedPrefix: prefix,
        highestCommittedIndex,
    };
    if (meta.captureId) return { ...meta, ...await writeCaptureStop(captureId, stop) };
    return { ...meta, ...stop };
}

/** Whether the stopped buffer has material beyond its verified contiguous prefix. */
export function captureHasGap(meta) {
    return !meta.completeIntent?.truncatedAtChunk && !meta.truncatedAtChunk &&
        Math.max(meta.chunkCount ?? 0, (meta.highestCommittedIndex ?? -1) + 1) > (meta.verifiedPrefix ?? -1) + 1;
}

/** List pending captures by persisted start time, with a deterministic tie break. */
export async function listPendingCaptures({ includeCleanup = false } = {}) {
    const ids = await listLocalSessions();
    const captures = await Promise.all(ids.map(async (id) => {
        const meta = await readLocalMeta(id).catch(() => null);
        return { id, meta };
    }));
    return captures.filter(({ meta }) => includeCleanup || !meta?.cleanupPending).sort((a, b) =>
        (Date.parse(a.meta?.startedAt) || 0) - (Date.parse(b.meta?.startedAt) || 0) ||
        a.id.localeCompare(b.id));
}

/** Read the server binding, including buffers from before the capture metadata upgrade. */
export function serverSessionFor(meta, captureId) {
    return Object.hasOwn(meta, "serverSessionId") ? meta.serverSessionId : captureId;
}

/** Subscribe to durable chunk confirmations for one capture, or all with a null ID. */
export function onCaptureChunk(captureId, listener) {
    const receive = (event) => {
        if (captureId === null || event.detail.captureId === captureId) listener(event);
    };
    chunkEvents.addEventListener("chunk", receive);
    return () => chunkEvents.removeEventListener("chunk", receive);
}

const chunkEvents = new EventTarget();

/** Publish a host confirmation and persist its contiguous encrypted prefix. */
export function confirmCaptureChunk(captureId, index) {
    chunkEvents.dispatchEvent(new CustomEvent("chunk", { detail: { captureId, index } }));
    return updateCapture(captureId, async (meta) => {
        const previous = meta.verifiedPrefix ?? -1;
        const highestCommittedIndex = Math.max(meta.highestCommittedIndex ?? -1, index);
        if (index <= previous) return { highestCommittedIndex };
        if (index === previous + 1) return { highestCommittedIndex, verifiedPrefix: index };
        return { highestCommittedIndex, verifiedPrefix: verifiedPrefix(await listChunkIndices(captureId, true), [], previous) };
    });
}
