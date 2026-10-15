const encoder = new TextEncoder();

/** Import the server's one-time capture key for encryption only. */
export async function importCaptureKey(base64) {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    if (bytes.length !== 32) throw new Error("Invalid capture key");
    return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt"]);
}

/** Encrypt one slice as version, nonce, ciphertext, and GCM tag. */
export async function encryptChunk(key, clientRecordingId, index, blob) {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const aad = encoder.encode(
        `chatterbox-recorder-v1:${clientRecordingId}:${index}`,
    );
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
        key,
        await blob.arrayBuffer(),
    );
    return new Blob([new Uint8Array([1]), nonce, ciphertext], {
        type: "application/octet-stream",
    });
}
