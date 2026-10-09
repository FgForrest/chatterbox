// Options page: pairing, server defaults, per-platform automatic recording,
// the one-time policy acknowledgement, microphone and recording settings.

import {
    grantHostAccess,
    originOf,
    registerPairingScript,
    storePairing,
} from "../lib/pairing.js";
import { PLATFORMS } from "../lib/platforms.js";
import {
    effectiveNoticeText,
    effectivePlatformModes,
    getSettings,
    saveSettings,
} from "../lib/settings.js";

const el = (id) => document.getElementById(id);

function setStatus(node, message, ok) {
    node.textContent = message;
    node.className = `status ${ok ? "ok" : "err"}`;
}

// ---- Connection -----------------------------------------------------------

el("save-connection").addEventListener("click", async () => {
    const serverUrl = el("server-url").value.trim().replace(/\/+$/, "");
    const apiKey = el("api-key").value.trim();
    const origin = originOf(serverUrl);
    if (!origin || !apiKey) {
        setStatus(
            el("connection-status"),
            "Enter a valid server URL (with https://) and a key.",
            false,
        );
        return;
    }
    // This click is the user gesture Chrome requires for a host grant.
    const granted = await grantHostAccess(origin);
    if (!granted) {
        setStatus(
            el("connection-status"),
            "Access to the server was not granted. The extension cannot upload without it.",
            false,
        );
        return;
    }
    await storePairing({ serverUrl: origin, apiKey });
    await registerPairingScript(origin);
    setStatus(el("connection-status"), "Connected.", true);
    await renderServerDefaults();
    await renderPlatformTable();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

el("refresh-config").addEventListener("click", async () => {
    const response = await chrome.runtime
        .sendMessage({ type: "refresh-config" })
        .catch((error) => ({ ok: false, error: String(error) }));
    if (response?.ok) {
        setStatus(el("connection-status"), "Server defaults refreshed.", true);
        await renderServerDefaults();
        await renderPlatformTable();
    } else {
        setStatus(
            el("connection-status"),
            response?.error ?? "Could not fetch server defaults.",
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
            ? "No server defaults fetched yet."
            : "";
        return;
    }
    const names = server.autoRecordPlatforms
        .map((id) => PLATFORMS.find((p) => p.id === id)?.name ?? id)
        .join(", ");
    node.textContent =
        `Server defaults (fetched ${new Date(server.fetchedAt).toLocaleString()}): ` +
        (names ? `automatic recording on ${names}` : "no automatic recording") +
        `, stop after ${server.autoStopQuietSeconds}s of silence` +
        (server.lockDefaults ? ", locked by the server." : ".");
}

// ---- Automatic recording ----------------------------------------------------

function sourceLabel(source) {
    switch (source) {
        case "locked":
            return "set by your server (locked)";
        case "server":
            return "server default";
        case "user":
            return "your choice";
        default:
            return "default";
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
            ["off", "Off"],
            ["prompt", "Prompt"],
            ["auto", "Auto"],
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
        el("shortcut").textContent = toggle?.shortcut || "not set";
    } catch {
        el("shortcut").textContent = "unknown";
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
    select.innerHTML = '<option value="">Default (recommended)</option>';
    for (const device of devices.filter((d) => d.kind === "audioinput")) {
        const option = document.createElement("option");
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${select.length}`;
        select.append(option);
    }
    select.value = settings.microphoneId || "";
}

el("grant-mic").addEventListener("click", async () => {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        await loadMicList();
    } catch {
        setStatus(el("save-status"), "Microphone access was denied.", false);
    }
});

// ---- Save ---------------------------------------------------------------

el("save-all").addEventListener("click", async () => {
    const settings = await getSettings();
    const modes = selectedModes();
    const anyAuto = Object.values(modes).includes("auto");

    let autoModeAcknowledgedAt = settings.autoModeAcknowledgedAt;
    if (anyAuto && !autoModeAcknowledgedAt) {
        if (!el("ack-check").checked) {
            setStatus(
                el("save-status"),
                "Confirm the recording policy to enable automatic recording.",
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
        localCopyPolicy: el("local-copy").value,
        downloadFolder: el("download-folder").value.trim() || "Riffado",
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
    setStatus(el("save-status"), "Saved.", true);
    await renderPlatformTable();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

// ---- Immediate-save controls --------------------------------------------

// The "Keep a local copy" choice has a visible side effect (a file written to
// disk), so it must not depend on remembering to click Save afterwards. It
// persists the moment it changes.
el("local-copy").addEventListener("change", async () => {
    await saveSettings({ localCopyPolicy: el("local-copy").value });
    setStatus(el("save-status"), "Saved.", true);
});

// ---- Restore ------------------------------------------------------------

async function restore() {
    const settings = await getSettings();
    const params = new URLSearchParams(location.search);
    el("server-url").value =
        settings.serverUrl || originOf(params.get("origin") ?? "") || "";
    el("api-key").value = settings.apiKey;
    el("local-copy").value = settings.localCopyPolicy;
    el("download-folder").value = settings.downloadFolder;
    el("channel-mode").value = settings.channelMode;
    el("notice-text").value = settings.noticeText ?? "";
    el("notice-text").placeholder = effectiveNoticeText(settings);
    el("nudge").checked = settings.nudgeEnabled;
    el("quiet-seconds").value = settings.autoStopQuietSeconds ?? "";
    el("quiet-seconds").placeholder = String(
        settings.serverDefaults?.autoStopQuietSeconds ?? 180,
    );
    if (settings.serverUrl && settings.apiKey) {
        setStatus(el("connection-status"), "Connected.", true);
    }
    await Promise.all([
        loadMicList(),
        renderServerDefaults(),
        renderPlatformTable(),
        renderShortcut(),
    ]);
}

restore();
