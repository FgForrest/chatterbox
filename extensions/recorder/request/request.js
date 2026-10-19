import { localizeDocument, t } from "../lib/i18n.js";
import { meetingLabel } from "../lib/meeting-target.js";
import { microphonePermission, requestMicrophone } from "../lib/microphone.js";
import { effectiveNoticeText, getSettings } from "../lib/settings.js";
import { START_REQUEST_KEY, START_REQUEST_TTL_MS } from "../lib/start-request.js";

localizeDocument();
const el = (id) => document.getElementById(id);
const requestId = new URL(location.href).searchParams.get("requestId");
let request;
let busy = false;

function acknowledged() {
    return Boolean(
        request?.input.noticeAcknowledgedAt || el("notice-check").checked,
    );
}

async function renderPermission() {
    const state = await microphonePermission();
    el("mic-status").textContent = t(
        state === "denied"
            ? "micReallow"
            : state === "granted"
              ? "micGranted"
              : "micWarning",
    );
    if (state === "denied")
        el("mic-status").textContent += ` (${chrome.runtime.id})`;
    el("grant-mic").hidden = state === "denied" || state === "granted";
    el("start").hidden = state !== "granted";
    return state;
}

async function resume(withoutMicrophone = false) {
    if (!request || busy) return;
    if (!acknowledged()) {
        el("mic-status").textContent = t("participantAckRequired");
        return;
    }
    busy = true;
    try {
        const response = await chrome.runtime.sendMessage({
            type: "resume-recording",
            requestId,
            withoutMicrophone,
            noticeAcknowledgedAt:
                request.input.noticeAcknowledgedAt ?? new Date().toISOString(),
        });
        if (!response?.ok)
            throw new Error(response?.error ?? t("couldNotStart"));
        window.close();
    } catch (error) {
        el("mic-status").textContent = error.message;
    } finally {
        busy = false;
    }
}

el("grant-mic").addEventListener("click", async () => {
    if (!acknowledged()) {
        el("mic-status").textContent = t("participantAckRequired");
        return;
    }
    if ((await renderPermission()) === "denied") return;
    try {
        await requestMicrophone();
        el("mic-status").textContent = t("micGranted");
        await chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
        await resume();
    } catch {
        const state = await renderPermission();
        if (state !== "denied") el("mic-status").textContent = t("micDenied");
    }
});
el("start").addEventListener("click", () => resume());
el("without-mic").addEventListener("click", () => resume(true));
el("cancel").addEventListener("click", () => window.close());
window.addEventListener("focus", async () => {
    if ((await renderPermission()) === "granted" && acknowledged())
        await resume();
});

async function restore() {
    request = (await chrome.storage.session.get(START_REQUEST_KEY))[
        START_REQUEST_KEY
    ];
    if (
        !request ||
        request.id !== requestId ||
        Date.now() - request.createdAt > START_REQUEST_TTL_MS
    ) {
        el("mic-status").textContent = t("recordingRequestExpired");
        for (const id of ["grant-mic", "start", "without-mic"])
            el(id).disabled = true;
        return;
    }
    const settings = await getSettings();
    el("notice-text").textContent = effectiveNoticeText(settings);
    el("notice-label").hidden = Boolean(request.input.noticeAcknowledgedAt);
    el("meeting-title").textContent = meetingLabel(request.tabUrl);
    await renderPermission();
}
void restore();
