import { listChunkIndices, readChunk } from "./chunk-store.js";
import { t } from "./i18n.js";
import { sealedRefusalMessage } from "./sealed-recording.js";

const day = 24 * 60 * 60 * 1000;

/** Display the measured size of locally retained ciphertext in decimal units. */
export function formatBufferedBytes(bytes) {
    const mb = bytes / 1_000_000;
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: mb < 10 ? 1 : 0 }).format(mb)} MB`;
}

/** Resolve a pending recording's state against the currently paired account. */
export function pendingRecordingStatus(meta, settings, unavailable, now = Date.now()) {
    const origin = settings.serverUrl ? new URL(settings.serverUrl).origin : null;
    const other = !settings.hasApiKey || (meta.pairing
        ? meta.pairing.serverOrigin !== origin ||
            (Boolean(meta.pairing.accountId) && meta.pairing.accountId !== settings.serverDefaults?.accountId)
        : meta.serverUrl !== settings.serverUrl);
    const uploaded = meta.uploadedParts ?? 0;
    const total = meta.chunkCount ?? (meta.verifiedPrefix ?? -1) + 1;
    const days = Math.floor((now - Date.parse(meta.startedAt)) / day);
    return {
        other,
        days: days >= 7 ? days : null,
        title: other ? t("offlineOtherConnection") : meta.refusal ? t("offlineRefused") :
            meta.serverSessionId && !meta.blocked && !unavailable ? t("offlineSending", [String(uploaded), String(total)]) :
                t(meta.protocol === 2 ? "offlineWaiting" : "pendingEncryptedRecording"),
        reason: !other && meta.refusal ? sealedRefusalMessage(meta.refusal) : null,
        local: !other && (unavailable || !meta.serverSessionId) && !meta.refusal,
    };
}

/** Use the host-reported size of a cleanly stopped buffer; measure older, interrupted or failed ones through OPFS. */
export async function pendingRecordingBytes(id, meta) {
    if (Number.isSafeInteger(meta.bufferedBytes) && !["browser-closed", "error"].includes(meta.stopReason)) return meta.bufferedBytes;
    let total = 0;
    for (const index of await listChunkIndices(id, true)) total += (await readChunk(id, index)).size;
    return total;
}
