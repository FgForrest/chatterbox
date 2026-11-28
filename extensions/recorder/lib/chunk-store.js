import { CHUNK_ENVELOPE_OVERHEAD } from "./chunk-crypto.js";

const ROOT_DIR = "recording-sessions";

async function root() {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function captureDir(captureId, create = false) {
    const dir = await root();
    return dir.getDirectoryHandle(captureId, { create });
}

function chunkName(index) {
    return `chunk-${String(index).padStart(6, "0")}`;
}

async function writeFile(dir, name, value, create = true) {
    const handle = await dir.getFileHandle(name, { create });
    const writable = await handle.createWritable();
    try {
        await writable.write(value);
        await writable.close();
    } catch (error) {
        await writable.abort?.().catch(() => {});
        throw error;
    }
}

/** Persist metadata in the capture's directory. */
export async function createLocalSession(captureId, meta, { create = true } = {}) {
    await withMetadata(captureId, async () => {
        const dir = await captureDir(captureId, create);
        const { agendaTitle: _agendaTitle, ...durable } = meta;
        await writeFile(dir, "meta.json", JSON.stringify(durable), create);
    });
}

async function readJson(dir, name) {
    try {
        const file = await (await dir.getFileHandle(name)).getFile();
        if (file.size === 0) return null;
        return { value: JSON.parse(await file.text()), lastModified: file.lastModified };
    } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
        return null;
    }
}

function withMetadata(captureId, change) {
    return navigator.locks.request(`recorder-meta:${captureId}`, change);
}

/** Read metadata, atomically upgrading released buffers in their existing directory. */
export function readLocalMeta(captureId) {
    return withMetadata(captureId, async () => {
        let dir;
        try {
            dir = await captureDir(captureId);
        } catch (error) {
            if (error?.name !== "NotFoundError") throw error;
            return null;
        }
        const record = await readJson(dir, "meta.json");
        if (!record) return null;
        const { agendaTitle: _agendaTitle, ...stored } = record.value;
        let meta = stored;
        const needsCommittedIndex = !meta.cleanupPending && !Number.isInteger(meta.highestCommittedIndex);
        if (!meta.captureId) {
            const serverSessionId = Object.hasOwn(meta, "serverSessionId") ? meta.serverSessionId : captureId;
            const indices = await listChunkIndices(captureId, true);
            meta = {
                ...meta,
                captureId,
                serverSessionId,
                protocol: 1,
                sealing: null,
                clientRecordingId: meta.clientRecordingId ?? null,
                startedAt: meta.startedAt ?? new Date(record.lastModified).toISOString(),
                stoppedAt: meta.stoppedAt ?? null,
                verifiedPrefix: contiguousPrefix(indices),
                highestCommittedIndex: indices.at(-1) ?? -1,
                pairing: null,
                createIntent: null,
                createOutcome: serverSessionId === null ? null : "attached",
            };
        } else if (needsCommittedIndex) {
            const indices = await listChunkIndices(captureId, true);
            meta.highestCommittedIndex = Math.max(meta.verifiedPrefix ?? -1, indices.at(-1) ?? -1);
        }
        if (!record.value.captureId || needsCommittedIndex || Object.hasOwn(record.value, "agendaTitle")) {
            await writeFile(dir, "meta.json", JSON.stringify(meta), false);
        }
        if (meta.cleanupPending) return meta;
        const stop = await readJson(dir, "stop.json");
        const sealing = meta.protocol === 2 ? await readJson(dir, "sealing.json") : null;
        return { ...meta, ...stop?.value, ...(sealing ? { sealing: sealing.value } : {}) };
    });
}

/** Persist the host's immutable public descriptor before recording starts. */
export async function writeCaptureSealing(captureId, sealing) {
    await withMetadata(captureId, async () => {
        const dir = await captureDir(captureId);
        await writeFile(dir, "sealing.json", JSON.stringify(sealing));
    });
}

function contiguousPrefix(indices) {
    const present = new Set(indices);
    let index = 0;
    while (present.has(index)) index++;
    return index - 1;
}

/** Persist the capture host's stop timestamp before sending its stop event. */
export async function writeCaptureStop(captureId, patch) {
    return withMetadata(captureId, async () => {
        const dir = await captureDir(captureId);
        const previous = (await readJson(dir, "stop.json"))?.value;
        const stop = {
            ...previous, ...patch,
            stoppedAt: previous?.stoppedAt ?? patch.stoppedAt,
        };
        await writeFile(dir, "stop.json", JSON.stringify(stop));
        return stop;
    });
}

/** Append a complete encrypted chunk to an existing capture. */
export async function writeChunk(captureId, index, blob) {
    const version = new Uint8Array(await blob.slice(0, 1).arrayBuffer())[0];
    if (!Number.isSafeInteger(index) || index < 0 || index > 999999 ||
        blob.type !== "application/octet-stream" || blob.size < CHUNK_ENVELOPE_OVERHEAD || version !== 1) {
        throw new Error("Invalid encrypted recording chunk");
    }
    const dir = await captureDir(captureId);
    await writeFile(dir, chunkName(index), blob);
}

export async function readChunk(captureId, index) {
    const dir = await captureDir(captureId);
    const handle = await dir.getFileHandle(chunkName(index));
    return handle.getFile();
}

/** Indices currently stored for a capture, ascending. */
export async function listChunkIndices(captureId, verify = false) {
    const indices = [];
    let dir;
    try {
        dir = await captureDir(captureId);
    } catch (error) {
        if (error?.name !== "NotFoundError") throw error;
        return indices;
    }
    for await (const [name, handle] of dir.entries()) {
        const match = /^chunk-(\d{6})$/.exec(name);
        if (match && (!verify || (handle.kind === "file" && (await handle.getFile()).size > 0))) indices.push(Number.parseInt(match[1], 10));
    }
    return indices.sort((a, b) => a - b);
}

/** List capture IDs that still have a directory in OPFS. */
export async function listLocalSessions() {
    const dir = await root();
    const ids = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") ids.push(name);
    }
    return ids;
}

export async function deleteLocalSession(captureId) {
    await withMetadata(captureId, async () => {
        const dir = await root();
        try {
            await dir.removeEntry(captureId, { recursive: true });
        } catch (error) {
            if (error?.name !== "NotFoundError") throw error;
        }
    });
}

/** Commit cancellation intent before removing any discarded audio or recording metadata. */
export async function discardLocalAudio(captureId, cleanup) {
    await withMetadata(captureId, async () => {
        const dir = await captureDir(captureId);
        await writeFile(dir, "meta.json", JSON.stringify(cleanup), false);
        for await (const [name] of dir.entries()) {
            if (name !== "meta.json") await dir.removeEntry(name);
        }
    });
}

/** Total bytes buffered across all captures, for the quota warning. */
export async function totalBufferedBytes() {
    let total = 0;
    for (const id of await listLocalSessions()) {
        for (const index of await listChunkIndices(id)) {
            const file = await readChunk(id, index);
            total += file.size;
        }
    }
    return total;
}
