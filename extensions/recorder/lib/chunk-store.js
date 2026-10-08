// Durable per-session chunk buffer in the Origin Private File System.
//
// Chunks are written here the moment the recorder emits them, so a dropped
// connection or a restarted service worker never loses captured audio: the
// upload queue reads back from OPFS, and the whole recording can be recovered
// after a browser crash. Each session is one directory of `chunk-<index>`
// files plus a small `meta.json`.

const ROOT_DIR = "recording-sessions";

async function root() {
    const opfs = await navigator.storage.getDirectory();
    return opfs.getDirectoryHandle(ROOT_DIR, { create: true });
}

async function sessionDir(sessionId, create = false) {
    const dir = await root();
    return dir.getDirectoryHandle(sessionId, { create });
}

function chunkName(index) {
    return `chunk-${String(index).padStart(6, "0")}`;
}

/** Create the session directory and persist its metadata. */
export async function createLocalSession(sessionId, meta) {
    const dir = await sessionDir(sessionId, true);
    const handle = await dir.getFileHandle("meta.json", { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(meta));
    await writable.close();
}

export async function readLocalMeta(sessionId) {
    try {
        const dir = await sessionDir(sessionId);
        const handle = await dir.getFileHandle("meta.json");
        const file = await handle.getFile();
        return JSON.parse(await file.text());
    } catch {
        return null;
    }
}

/** Append one chunk blob under its index. */
export async function writeChunk(sessionId, index, blob) {
    const dir = await sessionDir(sessionId, true);
    const handle = await dir.getFileHandle(chunkName(index), { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
}

export async function readChunk(sessionId, index) {
    const dir = await sessionDir(sessionId);
    const handle = await dir.getFileHandle(chunkName(index));
    return handle.getFile();
}

/** Indices currently stored for a session, ascending. */
export async function listChunkIndices(sessionId) {
    const indices = [];
    let dir;
    try {
        dir = await sessionDir(sessionId);
    } catch {
        return indices;
    }
    for await (const [name] of dir.entries()) {
        const match = /^chunk-(\d{6})$/.exec(name);
        if (match) indices.push(Number.parseInt(match[1], 10));
    }
    return indices.sort((a, b) => a - b);
}

/** Concatenate every stored chunk into one Blob, in order. */
export async function assembleBlob(sessionId, mimeType) {
    const indices = await listChunkIndices(sessionId);
    const parts = [];
    for (const index of indices) {
        parts.push(await readChunk(sessionId, index));
    }
    return new Blob(parts, { type: mimeType });
}

/** List session ids that still have a directory in OPFS. */
export async function listLocalSessions() {
    const dir = await root();
    const ids = [];
    for await (const [name, handle] of dir.entries()) {
        if (handle.kind === "directory") ids.push(name);
    }
    return ids;
}

export async function deleteLocalSession(sessionId) {
    const dir = await root();
    try {
        await dir.removeEntry(sessionId, { recursive: true });
    } catch {
        // already gone
    }
}

/** Total bytes buffered across all sessions, for the quota warning. */
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
