import { listLocalSessions, readLocalMeta } from "../lib/chunk-store.js";
import { localizeDocument, t } from "../lib/i18n.js";
import {
    microphoneError,
    microphonePermission,
    requestMicrophone,
} from "../lib/microphone.js";
import {
    clearPairing,
    connectOrigin,
    grantHostAccess,
    originOf,
    storePairing,
    unregisterPairingScripts,
} from "../lib/pairing.js";
import { PENDING_PAIR_KEY, SETUP_FLOW_KEY } from "../lib/pairing-request.js";
import { PLATFORMS } from "../lib/platforms.js";
import {
    effectiveNoticeText,
    effectivePlatformModes,
    getSettings,
    saveSettings,
} from "../lib/settings.js";
import {
    findRecorderSetupTabs,
    normalizeSetupAddress,
    prepareOriginSetup,
    returnToSetupTab,
} from "../lib/setup.js";
import { SETUP_FLOW_TTL_MS } from "../lib/setup-flow.js";
import {
    microphonePromptCopy,
    setupBrowserInfo,
    setupMicrophoneFailure,
} from "../lib/setup-microphone.js";

localizeDocument();
if (chrome.i18n.getUILanguage().toLowerCase().startsWith("cs")) {
    document.querySelector('a[data-i18n="privacyPolicy"]').href =
        "https://github.com/FgForrest/chatterbox/blob/dev/extensions/recorder/PRIVACY.cs.md";
}

const el = (id) => document.getElementById(id);
let dataUseConsentGranted = false;
let displayedPending = null;
let setupTarget = null;
let setupFlow = null;
let microphoneFailure = null;
let microphoneRetry = false;
let micPermission = "unknown";
let fallbackTimer;
let connecting = false;
const browserInfo = setupBrowserInfo();
const editedPlatforms = new Set();
const params = new URLSearchParams(location.search);

function requireDataUseConsent() {
    if (dataUseConsentGranted) return true;
    setStatus(el("data-use-status"), t("dataUseRequired"), false);
    el("setup-section").scrollIntoView({ behavior: "smooth" });
    return false;
}

function host(origin) {
    return origin ? new URL(origin).host : "";
}

async function loadSetupTarget() {
    const origin = originOf(params.get("origin") ?? "");
    const tabId = Number(params.get("tabId"));
    const surface = await chrome.tabs.getCurrent();
    const flow = (await chrome.storage.session.get(SETUP_FLOW_KEY))[
        SETUP_FLOW_KEY
    ];
    if (
        flow?.surfaceTabId === surface.id &&
        Date.now() - flow.createdAt >= 0 &&
        Date.now() - flow.createdAt < SETUP_FLOW_TTL_MS
    ) {
        setupFlow = flow;
    }
    if (
        origin &&
        params.has("tabId") &&
        Number.isInteger(tabId) &&
        tabId >= 0
    ) {
        setupTarget = { origin, tabId };
    } else if (setupFlow) {
        setupTarget = {
            origin: setupFlow.origin,
            tabId: setupFlow.tabId,
            typed: setupFlow.typed,
        };
    } else {
        const tabs = findRecorderSetupTabs(await chrome.tabs.query({}));
        setupTarget = tabs[0] ?? null;
        if (tabs.length > 1) {
            for (const tab of tabs) {
                const label = document.createElement("label");
                label.className = "pick";
                const radio = document.createElement("input");
                radio.type = "radio";
                radio.name = "setup-tab";
                radio.checked = tab === tabs[0];
                radio.addEventListener("change", () => {
                    setupTarget = tab;
                    renderTarget();
                });
                const name = document.createElement("span");
                name.textContent = host(tab.origin);
                const title = document.createElement("small");
                title.textContent = tab.title;
                label.append(radio, name, title);
                el("setup-tab-choices").append(label);
            }
        }
    }
    renderTarget();
}

function renderTarget() {
    const origin =
        setupTarget?.origin ?? normalizeSetupAddress(el("setup-address").value);
    el("setup-address-field").hidden = Boolean(setupTarget);
    el("setup-origin").textContent = setupTarget
        ? t("setupConnectIntro", host(origin))
        : t("setupTypeAddress");
    el("setup-connect").textContent = origin
        ? t("connectTo", host(origin))
        : t("connect");
    el("site-access-hint").textContent = setupFlow?.connected
        ? t("setupSiteGranted", host(origin))
        : t("setupSiteAccess", browserInfo.name);
    el("setup-fallback-text").textContent = t(
        setupFlow?.typed ? "setupFallbackTyped" : "setupFallback",
    );
}

function scheduleFallback() {
    clearTimeout(fallbackTimer);
    if (!setupFlow?.connected || setupFlow.completed) return;
    fallbackTimer = setTimeout(() => {
        el("setup-fallback").hidden = false;
        renderTarget();
    }, 5000);
}

el("setup-address").addEventListener("input", renderTarget);
el("setup-connect").addEventListener("click", async () => {
    if (!requireDataUseConsent() || connecting) return;
    const target = setupTarget ?? {
        origin: normalizeSetupAddress(el("setup-address").value),
        typed: true,
    };
    if (!target.origin) {
        setStatus(
            el("setup-connection-status"),
            t("invalidSetupAddress"),
            false,
        );
        return;
    }
    connecting = true;
    el("setup-connect").disabled = true;
    try {
        const prepared = prepareOriginSetup(target);
        setStatus(
            el("setup-connection-status"),
            t("setupConnecting", host(target.origin)),
            true,
        );
        setupTarget = await prepared;
        setupFlow = (await chrome.storage.session.get(SETUP_FLOW_KEY))[
            SETUP_FLOW_KEY
        ];
        setStatus(
            el("setup-connection-status"),
            t("setupWaiting", host(target.origin)),
            true,
        );
        renderTarget();
        scheduleFallback();
        await renderSetup();
    } catch (error) {
        setStatus(
            el("setup-connection-status"),
            error?.message ?? String(error),
            false,
        );
    } finally {
        connecting = false;
        el("setup-connect").disabled = false;
    }
});

async function focusSetupTab() {
    const target = setupFlow ?? setupTarget;
    if (!target) return;
    try {
        await returnToSetupTab(target.origin, target.tabId);
    } catch (error) {
        setStatus(el("setup-connection-status"), error.message, false);
    }
}
el("setup-return").addEventListener("click", focusSetupTab);
el("setup-focus").addEventListener("click", focusSetupTab);

el("accept-data-use").addEventListener("click", async () => {
    await saveSettings({ dataUseAcknowledgedAt: new Date().toISOString() });
    dataUseConsentGranted = true;
    await renderSetup();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

async function renderSetup() {
    const settings = await getSettings();
    dataUseConsentGranted = Boolean(settings.dataUseAcknowledgedAt);
    micPermission = await microphonePermission();
    if (setupFlow && Date.now() - setupFlow.createdAt >= SETUP_FLOW_TTL_MS) {
        setupFlow = null;
        clearTimeout(fallbackTimer);
        el("setup-fallback").hidden = true;
        setStatus(el("setup-connection-status"), t("setupExpired"), false);
    }
    const micAllowed = micPermission === "granted" && !microphoneFailure;
    const micDone = micAllowed || settings.microphoneSetupSkipped;
    const paired = Boolean(
        settings.serverUrl &&
            settings.hasApiKey &&
            (!setupTarget || settings.serverUrl === setupTarget.origin),
    );
    const step = !dataUseConsentGranted ? 1 : !micDone ? 2 : !paired ? 3 : 4;
    el("setup-section").hidden = step === 4;
    el("setup-ready").hidden = step !== 4;
    el("recorder-settings").hidden = step !== 4;
    el("setup-later").hidden = step === 4;
    el("manual-connection").hidden = step < 3;
    for (const [index, name] of [
        "consent",
        "microphone",
        "connect",
    ].entries()) {
        const number = index + 1;
        const done = number < step;
        const skipped = name === "microphone" && done && !micAllowed;
        el(`step-${name}`).className =
            `step ${skipped ? "skipped" : done ? "done" : number === step ? "active" : "future"}`;
        el(`step-${name}`).setAttribute?.(
            "aria-current",
            number === step ? "step" : "false",
        );
        el(`mark-${name}`).textContent = skipped
            ? "!"
            : done
              ? "✓"
              : String(number);
        el(`${name}-body`).hidden = number !== step;
        el(`${name}-summary`).hidden = !done;
    }
    el("consent-summary").textContent = t("dataUseSaved");
    el("microphone-summary").textContent = t(
        micAllowed ? "setupMicGranted" : "setupMicSkipped",
    );
    el("connect-summary").textContent = t("connected");
    el("paired-origin").textContent = t(
        "setupPaired",
        host(settings.serverUrl),
    );
    el("setup-ready-summary").textContent = t("setupReadySummary", [
        host(settings.serverUrl),
        t(micAllowed ? "setupMicGranted" : "setupMicSkipped"),
    ]);
    el("ready-grant-mic").hidden = micAllowed;
    el("setup-return").hidden = !setupFlow && !setupTarget;
    for (const radio of el("setup-tab-choices").querySelectorAll("input")) {
        radio.disabled = setupFlow?.connected === true && !setupFlow.completed;
    }
    el("setup-connect").hidden =
        setupFlow?.connected === true && !setupFlow.completed;
    if (step === 4) {
        clearTimeout(fallbackTimer);
        el("setup-fallback").hidden = true;
    }
    renderMicrophone();
}

async function renderPendingPair() {
    const pending = (await chrome.storage.session.get(PENDING_PAIR_KEY))[
        PENDING_PAIR_KEY
    ];
    displayedPending = pending;
    const origin = pending ? originOf(pending.serverUrl) : null;
    const target = setupFlow ?? (params.has("origin") ? setupTarget : null);
    const foreign =
        pending &&
        target &&
        (origin !== target.origin || pending.senderTabId !== target.tabId);
    el("confirm-pair").disabled = Boolean(foreign);
    setStatus(
        el("pending-status"),
        foreign ? t("setupProposalMismatch") : "",
        false,
    );
    el("pending-pair").hidden = !origin || !pending.apiKey;
    if (origin) {
        el("pending-origin").textContent = origin;
        el("pending-pair").scrollIntoView({ behavior: "smooth" });
    }
}

el("confirm-pair").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const proposal = displayedPending;
    const origin = proposal ? originOf(proposal.serverUrl) : null;
    if (!origin || !proposal.apiKey) {
        await renderPendingPair();
        return;
    }
    const target = setupFlow ?? (params.has("origin") ? setupTarget : null);
    if (
        target &&
        (origin !== target.origin || proposal.senderTabId !== target.tabId)
    ) {
        setStatus(el("pending-status"), t("setupProposalMismatch"), false);
        return;
    }
    try {
        const access = grantHostAccess(origin);
        const pending = (await chrome.storage.session.get(PENDING_PAIR_KEY))[
            PENDING_PAIR_KEY
        ];
        const granted = await access;
        if (
            pending?.serverUrl !== proposal.serverUrl ||
            pending?.apiKey !== proposal.apiKey ||
            pending?.senderTabId !== proposal.senderTabId
        ) {
            await renderPendingPair();
            return;
        }
        if (!granted) {
            setStatus(el("pending-status"), t("serverAccessDenied"), false);
            return;
        }
        await storePairing({
            serverUrl: origin,
            apiKey: proposal.apiKey,
            allowPendingRecovery: el("allow-pending-recovery").checked,
        });
        await connectOrigin(origin);
        setupTarget = Number.isInteger(proposal.senderTabId)
            ? { origin, tabId: proposal.senderTabId }
            : null;
        setupFlow = null;
        await chrome.storage.session.remove([PENDING_PAIR_KEY, SETUP_FLOW_KEY]);
        await unregisterPairingScripts();
        await renderPendingPair();
        await restore();
        await renderSetup();
        chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
    } catch (error) {
        setStatus(el("pending-status"), error?.message ?? String(error), false);
    }
});

el("reject-pair").addEventListener("click", async () => {
    await chrome.storage.session.remove(PENDING_PAIR_KEY);
    await renderPendingPair();
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "session" && changes[PENDING_PAIR_KEY])
        void renderPendingPair();
    if (area === "session" && changes[SETUP_FLOW_KEY] && setupFlow) {
        setupFlow = changes[SETUP_FLOW_KEY].newValue ?? null;
        void renderSetup();
    }
    if (area === "local" && (changes.encryptedApiKey || changes.serverUrl)) {
        void restore();
    }
});

function setStatus(node, message, ok) {
    node.textContent = message;
    node.className = `status ${ok ? "ok" : "err"}`;
}

el("save-connection").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const serverUrl = el("server-url").value.trim().replace(/\/+$/, "");
    const apiKey = el("api-key").value.trim();
    const origin = normalizeSetupAddress(serverUrl);
    if (!origin || !apiKey) {
        setStatus(el("connection-status"), t("invalidConnection"), false);
        return;
    }
    const granted = await grantHostAccess(origin);
    if (!granted) {
        setStatus(el("connection-status"), t("accessDenied"), false);
        return;
    }
    try {
        await storePairing({
            serverUrl: origin,
            apiKey,
            allowPendingRecovery: el("allow-pending-recovery").checked,
        });
        await connectOrigin(origin);
        if (setupTarget?.origin !== origin) setupTarget = null;
        setupFlow = null;
        await chrome.storage.session.remove(SETUP_FLOW_KEY);
    } catch (error) {
        setStatus(
            el("connection-status"),
            error?.message ?? String(error),
            false,
        );
        return;
    }
    el("api-key").value = "";
    setStatus(el("connection-status"), t("connected"), true);
    await restore();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

el("disconnect").addEventListener("click", async () => {
    try {
        await clearPairing();
        setupFlow = null;
        clearTimeout(fallbackTimer);
        el("setup-fallback").hidden = true;
        setStatus(el("setup-connection-status"), "", true);
        await restore();
    } catch (error) {
        setStatus(
            el("connection-status"),
            error?.message ?? String(error),
            false,
        );
    }
});

async function renderPendingBuffers() {
    const ids = await listLocalSessions();
    const list = el("pending-buffer-list");
    list.replaceChildren();
    el("pending-buffers").hidden = ids.length === 0;
    el("manual-recovery-label").hidden = ids.length === 0;
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
            else
                setStatus(
                    el("connection-status"),
                    result?.error ?? t("somethingWrong"),
                    false,
                );
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
        node.textContent = settings.serverUrl ? t("noDefaults") : "";
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
        select.addEventListener("change", () => {
            editedPlatforms.add(platform.id);
            void updateAckVisibility();
        });
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
        option.textContent =
            device.label || t("micLabel", String(select.length));
        select.append(option);
    }
    select.value = settings.microphoneId || "";
}

function renderMicrophone() {
    const copy = microphonePromptCopy(browserInfo);
    const granted = micPermission === "granted" && !microphoneFailure;
    const denied = micPermission === "denied";
    el("setup-mic-intro").textContent = denied
        ? t("setupMicBlocked", browserInfo.name)
        : copy.intro;
    el("mic-permanent").textContent = copy.permanent;
    el("mic-once").textContent = copy.temporary;
    el("mic-never").textContent = copy.deny;
    el("setup-mic-hint").textContent = copy.hint;
    el("mic-dialog-example").hidden = denied || Boolean(microphoneFailure);
    el("setup-mic-hint").hidden = denied || Boolean(microphoneFailure);
    el("setup-grant-mic").hidden = denied && !microphoneRetry;
    el("grant-mic").hidden = granted;
    el("grant-mic").textContent = t(
        denied ? "openMicSettings" : "setupGrantMic",
    );
    el("open-mic-settings").hidden = !denied;
    el("mic-managed-hint").hidden = !denied;
    el("mic-managed-hint").textContent = t("micManagedHint", browserInfo.name);
    const message =
        microphoneFailure ||
        t(
            granted ? "micGranted" : denied ? "setupMicBlocked" : "micWarning",
            browserInfo.name,
        );
    setStatus(
        el("setup-mic-status"),
        microphoneFailure || (denied ? message : ""),
        false,
    );
    setStatus(el("mic-status"), message, granted);
}

async function askMicrophone() {
    if (!requireDataUseConsent()) return;
    try {
        await requestMicrophone();
        microphoneFailure = null;
        microphoneRetry = false;
        await saveSettings({ microphoneSetupSkipped: false });
        await loadMicList();
    } catch (error) {
        const specific = setupMicrophoneFailure(error, browserInfo);
        microphoneRetry =
            Boolean(specific) &&
            /permission denied by system/i.test(error?.message ?? "");
        microphoneFailure =
            specific ||
            (["NotAllowedError", "SecurityError"].includes(error?.name)
                ? null
                : microphoneError(error?.name));
    }
    await renderSetup();
    await chrome.runtime
        .sendMessage({ type: "reevaluate-tabs" })
        .catch(() => {});
}

el("setup-grant-mic").addEventListener("click", askMicrophone);
el("grant-mic").addEventListener("click", async () => {
    micPermission = await microphonePermission();
    if (micPermission === "denied" && !microphoneFailure) {
        chrome.tabs.create({ url: "chrome://settings/content/microphone" });
        return;
    }
    await askMicrophone();
});
el("ready-grant-mic").addEventListener("click", async () => {
    await saveSettings({ microphoneSetupSkipped: false });
    await renderSetup();
    el("setup-section").scrollIntoView({ behavior: "smooth" });
});
el("skip-mic").addEventListener("click", async () => {
    await saveSettings({ microphoneSetupSkipped: true });
    await renderSetup();
});
el("open-mic-settings").addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://settings/content/microphone" });
});
window.addEventListener("focus", async () => {
    const state = await microphonePermission();
    if (state !== micPermission) microphoneFailure = null;
    await renderSetup();
});

el("save-all").addEventListener("click", async () => {
    if (!requireDataUseConsent()) return;
    const settings = await getSettings();
    const modes = selectedModes();
    const anyAuto = Object.values(modes).includes("auto");

    let autoModeAcknowledgedAt = settings.autoModeAcknowledgedAt;
    if (anyAuto && !autoModeAcknowledgedAt) {
        if (!el("ack-check").checked) {
            setStatus(el("save-status"), t("confirmPolicy"), false);
            el("ack-section").scrollIntoView({ behavior: "smooth" });
            return;
        }
        autoModeAcknowledgedAt = new Date().toISOString();
    }

    const effective = effectivePlatformModes({
        ...settings,
        platformModes: {},
    });
    const platformModes = {};
    for (const [id, mode] of Object.entries(modes)) {
        if (effective[id]?.source === "locked") continue;
        if (
            mode !== effective[id]?.mode ||
            settings.platformModes[id] ||
            editedPlatforms.has(id)
        )
            platformModes[id] = mode;
    }

    const quietRaw = el("quiet-seconds").value.trim();
    const quiet = quietRaw ? Number.parseInt(quietRaw, 10) : null;

    await saveSettings({
        microphoneId: el("mic-device").value,
        micReminderDismissed: !el("mic-reminder").checked,
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
    editedPlatforms.clear();
    setStatus(el("save-status"), t("saved"), true);
    await renderPlatformTable();
    chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
});

async function restore() {
    const settings = await getSettings();
    dataUseConsentGranted = Boolean(settings.dataUseAcknowledgedAt);
    const params = new URLSearchParams(location.search);
    el("server-url").value =
        settings.serverUrl || originOf(params.get("origin") ?? "") || "";
    el("api-key").value = "";
    el("channel-mode").value = settings.channelMode;
    el("notice-text").value = settings.noticeText ?? "";
    el("notice-text").placeholder = effectiveNoticeText(settings);
    el("nudge").checked = settings.nudgeEnabled;
    el("mic-reminder").checked = !settings.micReminderDismissed;
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
    await renderSetup();
    if (params.has("microphone") && micPermission !== "granted") {
        el("grant-mic").scrollIntoView();
    }
    if (settings.dataUseAcknowledgedAt) await loadMicList();
}

await loadSetupTarget();
scheduleFallback();
await restore();
