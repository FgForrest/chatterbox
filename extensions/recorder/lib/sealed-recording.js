import { t } from "./i18n.js";

const algorithm = "ECDH-P256-HKDF-SHA256-A256GCM";
const ecdh = { name: "ECDH", namedCurve: "P-256" };
const encoder = new TextEncoder();

function encode(bytes) {
    return btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode canonical unpadded base64url. */
export function decodeSealedBytes(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
    const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
    if (encode(bytes) !== value) throw new Error("Invalid base64url");
    return bytes;
}

function importRecipient({ publicKey }) {
    return crypto.subtle.importKey("spki", decodeSealedBytes(publicKey), ecdh, false, []);
}

/** Accept a recipient only after validating the config's key and its pairing identity. */
export async function offlineConfig(config, settings) {
    const previous = settings.serverDefaults;
    const serverOrigin = new URL(settings.serverUrl).origin;
    const accountId = typeof config.account?.id === "string" && config.account.id.trim()
        ? config.account.id : null;
    const cache = previous?.offlineRecipient;
    const sameAccount = cache?.serverOrigin === serverOrigin && (!accountId || cache.accountId === accountId);
    let offlineRecipient = sameAccount ? cache : null;
    const offlineRecording = config.features?.offlineRecording === 1 && Boolean(accountId);
    const candidate = config.offlineKey;
    if (offlineRecording && accountId && candidate?.alg === algorithm &&
        typeof candidate.kid === "string" && candidate.kid.length >= 1 && candidate.kid.length <= 64 &&
        !/[^A-Za-z0-9_-]/.test(candidate.kid) &&
        typeof candidate.publicKey === "string" && candidate.publicKey.length <= 256) {
        try {
            await importRecipient(candidate);
            offlineRecipient = {
                serverOrigin, accountId, kid: candidate.kid, alg: candidate.alg, publicKey: candidate.publicKey,
            };
        } catch {}
    }
    return {
        accountId: accountId ?? (sameAccount ? cache.accountId : previous?.accountId ?? null),
        offlineRecording,
        offlineRecipient,
        maxSessionBytes: validSessionLimit(config.limits?.max_session_bytes) ??
            (accountId && previous?.accountId !== accountId ? null : previous?.maxSessionBytes),
    };
}

/** Select protocol 2 only for the currently paired, advertised recipient. */
export function sealedRecipient(settings) {
    const defaults = settings.serverDefaults;
    const cached = defaults?.offlineRecipient;
    return settings.serverUrl && settings.hasApiKey && defaults?.offlineRecording === true && cached &&
        cached.accountId === defaults.accountId &&
        cached.serverOrigin === new URL(settings.serverUrl).origin ? cached : null;
}

/** Snapshot the negotiated start path and the pairing that supplied it. */
export function recordingStartPath(settings) {
    return {
        serverUrl: settings.serverUrl,
        connectionId: settings.connectionId,
        recipient: sealedRecipient(settings),
        legacySupported: settings.serverDefaults?.encryptedRecordingProtocol === 1,
    };
}

/** Validate an optional server-provided encrypted session size ceiling. */
export function validSessionLimit(value) {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Derive the non-extractable key used by the ordinary encrypted chunk envelope. */
export async function deriveSealedKey(recipient, privateKey, salt, kid, clientRecordingId) {
    const publicKey = await importRecipient(recipient);
    const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: encoder.encode(`chatterbox-recorder-offline-v1:${kid}:${clientRecordingId}`),
    }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
}

/** Create one ephemeral key and its public descriptor inside the capture host. */
export async function sealCapture(recipient, clientRecordingId) {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(ecdh, false, ["deriveBits"]);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveSealedKey(recipient, privateKey, salt, recipient.kid, clientRecordingId);
    return {
        key,
        sealing: {
            protocol: 2,
            kid: recipient.kid,
            ephemeralPublicKey: encode(await crypto.subtle.exportKey("raw", publicKey)),
            salt: encode(salt),
        },
    };
}

/** Describe known refusals and preserve the paired server's message for the rest. */
export function sealedRefusalMessage(refusal) {
    if (refusal.code === "STORAGE_QUOTA_EXCEEDED") return t("offlineStorageRefused");
    if (refusal.code === "OFFLINE_KEY_UNAVAILABLE") return t("offlineKeyRefused");
    return refusal.message;
}
