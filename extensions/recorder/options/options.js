// Options page: pairing, server defaults, per-platform automatic recording,
// the one-time policy acknowledgement, microphone and recording settings.

import {
    clearPairing,
    grantHostAccess,
    originOf,
    registerPairingScript,
    storePairing,
} from "../lib/pairing.js";
import { listLocalSessions, readLocalMeta } from "../lib/chunk-store.js";
import { PLATFORMS } from "../lib/platforms.js";
import {
    effectiveNoticeText,
    effectivePlatformModes,
    getSettings,
    saveSettings,
} from "../lib/settings.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { PENDING_PAIR_KEY } from "../lib/pairing-request.js";

localizeDocument();
if (chrome.i18n.getUILanguage().toLowerCase().startsWith("cs")) {
    document.querySelector('a[data-i18n="privacyPolicy"]').href =
        "https://github.com/FgForrest/chatterbox/blob/dev/extensions/recorder/PRIVACY.cs.md";
}

const el = (id) => document.getElementById(id);
let dataUseConsentGranted = false;

function requireDataUseConsent() {
    if (dataUseConsentGranted) return true;
    setStatus(el("data-use-status"), t("dataUseRequired"), false);
    el("data-use-section").scrollIntoView({ behavior: "smooth" });
    return false;
}

el("accept-data-use").addEventListener("click", async () => {
    if (!el("data-use-check").checked) {
        setStatus(el("data-use-status"), t("dataUseRequired"), false);
        return;
    }
    await saveSettings({ dataUseAcknowledgedAt: new Date().toISOString() });
    dataUseConsentGranted = true;
    el("data-use-label").hidden = true;
    el("accept-data-use").hidden = true;
    setStatus(el("data-use-status"), t("dataUseSaved"), true);
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

async function renderPendingPair() {
    const pending = (await chrome.storage.session.get(PENDING_PAIR_KEY))[
        PENDING_PAIR_KEY
    ];
    const origin = pending ? originOf(pending.serverUrl) : null;
    el("pending-pair").hidden = !origin || !pending.apiKey;
    if (origin) el("pending-origin").textContent = origin;
}

el("confirm-pair").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const pending = (await chrome.storage.session.get(PENDING_PAIR_KEY))[
        PENDING_PAIR_KEY
    ];
    const origin = pending ? originOf(pending.serverUrl) : null;
    if (!origin || !pending.apiKey) {
        await renderPendingPair();
        return;
    }
    const granted = await grantHostAccess(origin);
    if (!granted) {
        setStatus(el("pending-status"), t("serverAccessDenied"), false);
        return;
    }
    try {
        await storePairing({
            serverUrl: origin,
            apiKey: pending.apiKey,
            allowPendingRecovery: el("allow-pending-recovery").checked,
        });
    } catch (error) {
        setStatus(el("pending-status"), error?.message ?? String(error), false);
        return;
    }
    await registerPairingScript(origin);
    await chrome.storage.session.remove(PENDING_PAIR_KEY);
    await renderPendingPair();
    await restore();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

el("reject-pair").addEventListener("click", async () => {
    await chrome.storage.session.remove(PENDING_PAIR_KEY);
    await renderPendingPair();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[PENDING_PAIR_KEY]) {
        void renderPendingPair();
    }
});

function setStatus(node, message, ok) {
    node.textContent = message;
    node.className = `status ${ok ? "ok" : "err"}`;
}

// ---- Connection -----------------------------------------------------------

el("save-connection").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const serverUrl = el("server-url").value.trim().replace(/\/+$/, "");
    const apiKey = el("api-key").value.trim();
    const origin = originOf(serverUrl);
    if (!origin || !apiKey) {
        setStatus(
            el("connection-status"),
            t("invalidConnection"),
            false,
        );
        return;
    }
    // This click is the user gesture Chrome requires for a host grant.
    const granted = await grantHostAccess(origin);
    if (!granted) {
        setStatus(
            el("connection-status"),
            t("accessDenied"),
            false,
        );
        return;
    }
    try {
        await storePairing({
            serverUrl: origin,
            apiKey,
            allowPendingRecovery: el("allow-pending-recovery").checked,
        });
    } catch (error) {
        setStatus(el("connection-status"), error?.message ?? String(error), false);
        return;
    }
    el("api-key").value = "";
    await registerPairingScript(origin);
    setStatus(el("connection-status"), t("connected"), true);
    await renderServerDefaults();
    await renderPlatformTable();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

el("disconnect").addEventListener("click", async () => {
    try {
        await clearPairing();
        await restore();
        setStatus(el("connection-status"), t("disconnected"), true);
    } catch (error) {
        setStatus(el("connection-status"), error?.message ?? String(error), false);
    }
});

async function renderPendingBuffers() {
    const ids = await listLocalSessions();
    const list = el("pending-buffer-list");
    list.replaceChildren();
    el("pending-buffers").hidden = ids.length === 0;
    for (const id of ids) {
        const meta = await readLocalMeta(id);
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = `${meta?.serverUrl ?? t("unknown")} · ${meta?.startedAt ?? id} · ${meta?.clientRecordingId ?? ""} · ${meta?.keyExpiresAt ?? ""}`;
        const check = document.createElement("input");
        check.type = "checkbox";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = t("discard");
        button.disabled = true;
        check.addEventListener("change", () => {
            button.disabled = !check.checked;
        });
        button.addEventListener("click", async () => {
            const result = await chrome.runtime.sendMessage({
                type: "discard-buffer",
                bufferId: id,
            });
            if (result?.ok) await renderPendingBuffers();
            else setStatus(el("connection-status"), result?.error ?? t("somethingWrong"), false);
        });
        item.append(label, check, button);
        list.append(item);
    }
}

el("refresh-config").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const response = await chrome.runtime
        .sendMessage({ type: "refresh-config" })
        .catch((error) => ({ ok: false, error: String(error) }));
    if (response?.ok) {
        setStatus(el("connection-status"), t("defaultsRefreshed"), true);
        await renderServerDefaults();
        await renderPlatformTable();
    } else {
        setStatus(
            el("connection-status"),
            response?.error ?? t("defaultsFailed"),
            false,
        );
    }
});

async function renderServerDefaults() {
    const settings = await getSettings();
    const node = el("server-defaults");
    const server = settings.serverDefaults;
    if (!server) {
        node.textContent = settings.serverUrl
            ? t("noDefaults")
            : "";
        return;
    }
    const names = server.autoRecordPlatforms
        .map((id) => PLATFORMS.find((p) => p.id === id)?.name ?? id)
        .join(", ");
    node.textContent = t("defaultsSummary", [
        new Date(server.fetchedAt).toLocaleString(),
        names ? t("autoOn", names) : t("autoOff"),
        String(server.autoStopQuietSeconds),
        server.lockDefaults ? t("lockedSuffix") : t("period"),
    ]);
}

// ---- Automatic recording ----------------------------------------------------

function sourceLabel(source) {
    switch (source) {
        case "locked":
            return t("sourceLocked");
        case "server":
            return t("sourceServer");
        case "user":
            return t("sourceUser");
        default:
            return t("sourceDefault");
    }
}

async function renderPlatformTable() {
    const settings = await getSettings();
    const effective = effectivePlatformModes(settings);
    const tbody = el("platform-table").querySelector("tbody");
    tbody.innerHTML = "";
    for (const platform of PLATFORMS) {
        const entry = effective[platform.id];
        const row = document.createElement("tr");

        const name = document.createElement("td");
        name.textContent = platform.name;

        const modeCell = document.createElement("td");
        const select = document.createElement("select");
        select.dataset.platform = platform.id;
        for (const [value, label] of [
            ["off", t("off")],
            ["prompt", t("prompt")],
            ["auto", t("auto")],
        ]) {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            select.append(option);
        }
        select.value = entry.mode;
        select.disabled = entry.source === "locked";
        select.addEventListener("change", updateAckVisibility);
        modeCell.append(select);

        const source = document.createElement("td");
        source.className = "hint";
        source.textContent = sourceLabel(entry.source);

        row.append(name, modeCell, source);
        tbody.append(row);
    }
    await updateAckVisibility();
}

function selectedModes() {
    const modes = {};
    for (const select of el("platform-table").querySelectorAll("select")) {
        modes[select.dataset.platform] = select.value;
    }
    return modes;
}

async function updateAckVisibility() {
    const settings = await getSettings();
    const anyAuto = Object.values(selectedModes()).includes("auto");
    const needsAck = anyAuto && !settings.autoModeAcknowledgedAt;
    el("ack-section").hidden = !needsAck;
    if (needsAck) {
        el("ack-text").textContent = effectiveNoticeText(settings);
    }
}

async function renderShortcut() {
    try {
        const commands = await chrome.commands.getAll();
        const toggle = commands.find((c) => c.name === "toggle-recording");
        el("shortcut").textContent = toggle?.shortcut || t("notSet");
    } catch {
        el("shortcut").textContent = t("unknown");
    }
}

el("open-shortcuts").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ---- Microphone ---------------------------------------------------------

async function loadMicList() {
    const select = el("mic-device");
    let devices;
    try {
        devices = await navigator.mediaDevices.enumerateDevices();
    } catch {
        return;
    }
    const settings = await getSettings();
    select.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = t("defaultRecommended");
    select.append(defaultOption);
    for (const device of devices.filter((d) => d.kind === "audioinput")) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || t("micLabel", String(select.length));
        select.append(option);
    }
    select.value = settings.microphoneId || "";
}

el("grant-mic").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        await loadMicList();
    } catch {
        setStatus(el("save-status"), t("micDenied"), false);
    }
});

// ---- Save ---------------------------------------------------------------

el("save-all").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const settings = await getSettings();
    const modes = selectedModes();
    const anyAuto = Object.values(modes).includes("auto");

    let autoModeAcknowledgedAt = settings.autoModeAcknowledgedAt;
    if (anyAuto && !autoModeAcknowledgedAt) {
        if (!el("ack-check").checked) {
            setStatus(
                el("save-status"),
                t("confirmPolicy"),
                false,
            );
            el("ack-section").scrollIntoView({ behavior: "smooth" });
            return;
        }
        autoModeAcknowledgedAt = new Date().toISOString();
    }

    // Store only choices that differ from what the server or default would
    // give, so a later server change still flows through for untouched rows.
    const effective = effectivePlatformModes({ ...settings, platformModes: {} });
    const platformModes = {};
    for (const [id, mode] of Object.entries(modes)) {
        if (effective[id]?.source === "locked") continue;
        if (mode !== effective[id]?.mode) platformModes[id] = mode;
    }

    const quietRaw = el("quiet-seconds").value.trim();
    const quiet = quietRaw ? Number.parseInt(quietRaw, 10) : null;

    await saveSettings({
        microphoneId: el("mic-device").value,
        channelMode: el("channel-mode").value === "split" ? "split" : "mixed",
        noticeText: el("notice-text").value.trim() || null,
        platformModes,
        nudgeEnabled: el("nudge").checked,
        autoStopQuietSeconds:
            quiet != null && Number.isFinite(quiet) && quiet >= 30
                ? Math.min(3600, quiet)
                : null,
        autoModeAcknowledgedAt,
    });
    setStatus(el("save-status"), t("saved"), true);
    await renderPlatformTable();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

// ---- Restore ------------------------------------------------------------

async function restore() {
    const settings = await getSettings();
    dataUseConsentGranted = Boolean(settings.dataUseAcknowledgedAt);
    if (settings.dataUseAcknowledgedAt) {
        el("data-use-label").hidden = true;
        el("accept-data-use").hidden = true;
        setStatus(el("data-use-status"), t("dataUseSaved"), true);
    }
    const params = new URLSearchParams(location.search);
    el("server-url").value =
        settings.serverUrl || originOf(params.get("origin") ?? "") || "";
    el("api-key").value = "";
    el("channel-mode").value = settings.channelMode;
    el("notice-text").value = settings.noticeText ?? "";
    el("notice-text").placeholder = effectiveNoticeText(settings);
    el("nudge").checked = settings.nudgeEnabled;
    el("quiet-seconds").value = settings.autoStopQuietSeconds ?? "";
    el("quiet-seconds").placeholder = String(
        settings.serverDefaults?.autoStopQuietSeconds ?? 180,
    );
    if (settings.serverUrl && settings.hasApiKey) {
        setStatus(el("connection-status"), t("connected"), true);
    }
    await Promise.all([
        renderPendingBuffers(),
        renderPendingPair(),
        renderServerDefaults(),
        renderPlatformTable(),
        renderShortcut(),
    ]);
    if (settings.dataUseAcknowledgedAt) await loadMicList();
}

restore();
