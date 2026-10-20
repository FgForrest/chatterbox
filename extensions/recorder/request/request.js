import { fitWindowToContent } from "../lib/fit-window.js";
import { localizeDocument, t } from "../lib/i18n.js";
import { meetingLabel } from "../lib/meeting-target.js";
import { microphonePermission, requestMicrophone } from "../lib/microphone.js";
import { effectiveNoticeText, getSettings } from "../lib/settings.js";
import { START_REQUEST_KEY, START_REQUEST_TTL_MS } from "../lib/start-request.js";

localizeDocument();
fitWindowToContent();
const el = (id) => document.getElementById(id);
const requestId = new URL(location.href).searchParams.get("requestId");
let request;
let busy = false;

// The popup's and the notification's buttons already carry consent;
// otherwise this page's record buttons do, by their wording.
function consented() {
    return Boolean(request?.input.noticeAcknowledgedAt);
}

const MIC_STATUS = { denied: "micReallow", granted: "micGranted" };

async function renderPermission() {
    const state = await microphonePermission();
    el("mic-status").textContent = t(MIC_STATUS[state] ?? "micWarning");
    if (state === "denied")
        el("mic-status").textContent += ` (${chrome.runtime.id})`;
    el("grant-mic").hidden = state === "denied" || state === "granted";
    el("start").hidden = state !== "granted";
    return state;
}

async function resume(withoutMicrophone = false) {
    if (!request || busy) return;
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
    if ((await renderPermission()) === "denied") return;
    try {
        await requestMicrophone();
        await chrome.runtime.sendMessage({ type: "reevaluate-tabs" }).catch(() => {});
        if ((await renderPermission()) === "granted" && consented()) await resume();
    } catch {
        const state = await renderPermission();
        if (state !== "denied") el("mic-status").textContent = t("micDenied");
    }
});
el("start").addEventListener("click", () => resume());
el("without-mic").addEventListener("click", () => resume(true));
el("cancel").addEventListener("click", () => window.close());
window.addEventListener("focus", async () => {
    if ((await renderPermission()) === "granted" && consented()) await resume();
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
    const asks = !consented();
    el("notice-text").textContent = effectiveNoticeText(settings);
    el("notice-text").hidden = !asks;
    el("start").textContent = t(asks ? "recordWithConsent" : "record");
    el("without-mic").textContent = t(
        asks ? "recordWithoutMicWithConsent" : "recordWithoutMic",
    );
    el("meeting-title").textContent = meetingLabel(request.tabUrl);
    await renderPermission();
}
void restore();
