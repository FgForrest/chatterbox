import { t } from "./i18n.js";
import {
    hasMeetingPromptAccess,
    MEETING_PROMPT_DISMISSED,
    removeMeetingPromptAccess,
    requestMeetingPromptAccess,
} from "./meeting-prompt.js";

import { isPaired } from "./settings.js";

/** Bind setup and options switches to the same optional host permission. */
export function bindMeetingPromptSwitches(inputs, status) {
    async function refresh() {
        const enabled = await hasMeetingPromptAccess();
        for (const input of inputs) input.checked = enabled;
    }
    for (const input of inputs) {
        input.addEventListener("change", async () => {
            const permission = input.checked
                ? requestMeetingPromptAccess()
                : removeMeetingPromptAccess();
            for (const control of inputs) control.disabled = true;
            try {
                const granted = await permission;
                status.textContent = granted
                    ? ""
                    : t("meetingPromptAccessDenied");
            } catch (error) {
                status.textContent =
                    error?.message || t("meetingPromptAccessDenied");
            } finally {
                await refresh();
                for (const control of inputs) control.disabled = false;
            }
        });
    }
    chrome.permissions.onAdded.addListener(refresh);
    chrome.permissions.onRemoved.addListener(refresh);
    return refresh();
}

/** Bind the one-time popup offer without relying on the popup staying open during a grant. */
export function bindMeetingPromptOffer({ offer, enable, dismiss, status }) {
    async function refresh(paired = null) {
        const settings = await chrome.storage.local.get(
            MEETING_PROMPT_DISMISSED,
        );
        offer.hidden =
            !(paired ?? (await isPaired())) ||
            settings[MEETING_PROMPT_DISMISSED] === true ||
            (await hasMeetingPromptAccess());
    }
    enable.addEventListener("click", async () => {
        const permission = requestMeetingPromptAccess();
        enable.disabled = true;
        try {
            const granted = await permission;
            if (granted) {
                await chrome.storage.local.set({
                    [MEETING_PROMPT_DISMISSED]: true,
                });
                offer.hidden = true;
            } else status.textContent = t("meetingPromptAccessDenied");
        } catch (error) {
            status.textContent =
                error?.message || t("meetingPromptAccessDenied");
        } finally {
            enable.disabled = false;
        }
    });
    dismiss.addEventListener("click", async () => {
        await chrome.storage.local.set({ [MEETING_PROMPT_DISMISSED]: true });
        offer.hidden = true;
    });
    chrome.permissions?.onAdded?.addListener(() => {
        void refresh().catch(() => {});
    });
    return refresh;
}
