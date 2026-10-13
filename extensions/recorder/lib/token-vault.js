const DB_NAME = "chatterbox-recorder-vault";
const STORE_NAME = "keys";
const KEY_ID = "recorder-token";
const TOKEN_STORAGE_KEY = "encryptedApiKey";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function readKey() {
    const database = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, "readonly");
            const request = transaction.objectStore(STORE_NAME).get(KEY_ID);
            request.onsuccess = () => resolve(request.result ?? null);
            request.onerror = () => reject(request.error);
        });
    } finally {
        database.close();
    }
}

async function writeKey(key) {
    const database = await openDatabase();
    try {
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, "readwrite");
            transaction.objectStore(STORE_NAME).put(key, KEY_ID);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
    } finally {
        database.close();
    }
}

/** Encrypt a newly accepted recorder token before persisting it. */
export async function storeToken(token) {
    let key = await readKey();
    if (!key) {
        key = await crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
        await writeKey(key);
    }
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce },
        key,
        encoder.encode(token),
    );
    await chrome.storage.local.set({
        [TOKEN_STORAGE_KEY]: {
            version: 1,
            nonce: Array.from(nonce),
            ciphertext: Array.from(new Uint8Array(ciphertext)),
        },
    });
    await chrome.storage.local.remove("apiKey");
}

/** Decrypt the recorder token only for requests to the paired server. */
export async function readToken() {
    const stored = (await chrome.storage.local.get(TOKEN_STORAGE_KEY))[
        TOKEN_STORAGE_KEY
    ];
    if (!stored) return "";
    if (stored.version !== 1) throw new Error("Recorder token needs re-pairing");
    const key = await readKey();
    if (!key) throw new Error("Recorder token needs re-pairing");
    try {
        const plaintext = await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: new Uint8Array(stored.nonce) },
            key,
            new Uint8Array(stored.ciphertext),
        );
        return decoder.decode(plaintext);
    } catch {
        throw new Error("Recorder token needs re-pairing");
    }
}

export async function clearToken() {
    await chrome.storage.local.remove(TOKEN_STORAGE_KEY);
}
