// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MEETING_PROMPT_DISMISSED } from "../../../extensions/recorder/lib/meeting-prompt.js";
import {
    bindMeetingPromptOffer,
    bindMeetingPromptSwitches,
} from "../../../extensions/recorder/lib/meeting-prompt-ui.js";
import { MEETING_PROMPT_ORIGINS } from "../../../extensions/recorder/lib/platforms.js";

let local;
let granted;
let events;
beforeEach(() => {
    local = {
        serverUrl: "https://recorder.example",
        encryptedApiKey: { ciphertext: "test" },
    };
    granted = false;
    events = {};
    vi.stubGlobal("chrome", {
        i18n: { getMessage: (key) => key },
        storage: {
            local: {
                get: async () => ({ ...local }),
                set: async (patch) => Object.assign(local, patch),
            },
        },
        permissions: {
            contains: vi.fn(async () => granted),
            request: vi.fn(async () => {
                granted = true;
                return true;
            }),
            remove: vi.fn(async () => {
                granted = false;
                return true;
            }),
            onAdded: {
                addListener: (listener) => {
                    events.added = listener;
                },
            },
            onRemoved: {
                addListener: (listener) => {
                    events.removed = listener;
                },
            },
        },
    });
});
afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

function offer() {
    document.body.innerHTML = readFileSync(
        "extensions/recorder/popup/popup.html",
        "utf8",
    );
    const node = (id) => document.getElementById(id);
    const controls = {
        offer: node("meeting-prompt-offer"),
        enable: node("enable-meeting-prompt"),
        dismiss: node("dismiss-meeting-prompt"),
        status: node("meeting-prompt-offer-status"),
    };
    return { ...controls, refresh: bindMeetingPromptOffer(controls) };
}

describe("meeting prompt popup offer", () => {
    it("shows only when paired, disabled, and not dismissed", async () => {
        const ui = offer();
        await ui.refresh(false);
        expect(ui.offer.hidden).toBe(true);
        await ui.refresh(true);
        expect(ui.offer.hidden).toBe(false);
        granted = true;
        await ui.refresh(true);
        expect(ui.offer.hidden).toBe(true);
    });
    it("hides for good after Not now, including on the next popup", async () => {
        let ui = offer();
        await ui.refresh(true);
        ui.dismiss.click();
        await vi.waitFor(() => expect(ui.offer.hidden).toBe(true));
        expect(local[MEETING_PROMPT_DISMISSED]).toBe(true);
        ui = offer();
        await ui.refresh(true);
        expect(ui.offer.hidden).toBe(true);
        expect(chrome.permissions.request).not.toHaveBeenCalled();
    });
    it("requests every meeting origin immediately from a click and hides on enabling", async () => {
        const ui = offer();
        await ui.refresh(true);
        ui.enable.click();
        expect(chrome.permissions.request).toHaveBeenCalledExactlyOnceWith({
            origins: MEETING_PROMPT_ORIGINS,
        });
        await vi.waitFor(() => expect(ui.offer.hidden).toBe(true));
        expect(local[MEETING_PROMPT_DISMISSED]).toBe(true);
    });
    it("refreshes from the permission event even when the request promise is lost with the popup", async () => {
        const ui = offer();
        await ui.refresh(true);
        chrome.permissions.request.mockReturnValue(new Promise(() => {}));
        ui.enable.click();
        granted = true;
        await events.added();
        await vi.waitFor(() => expect(ui.offer.hidden).toBe(true));
    });
    it("leaves the offer available after permission refusal", async () => {
        const ui = offer();
        await ui.refresh(true);
        chrome.permissions.request.mockResolvedValue(false);
        ui.enable.click();
        await vi.waitFor(() =>
            expect(ui.status.textContent).toBe("meetingPromptAccessDenied"),
        );
        expect(ui.offer.hidden).toBe(false);
        expect(local[MEETING_PROMPT_DISMISSED]).toBeUndefined();
    });
});

describe("meeting prompt options and setup switches", () => {
    it("uses the existing three-step setup and synchronizes both switches on grant and removal", async () => {
        document.body.innerHTML = readFileSync(
            "extensions/recorder/options/options.html",
            "utf8",
        );
        expect(document.querySelectorAll("ol.steps > li")).toHaveLength(3);
        const inputs = ["setup-meeting-prompt", "meeting-prompt-switch"].map(
            (id) => document.getElementById(id),
        );
        const status = document.getElementById("meeting-prompt-status");
        await bindMeetingPromptSwitches(inputs, status);
        expect(inputs.every((input) => !input.checked)).toBe(true);
        inputs[0].checked = true;
        inputs[0].dispatchEvent(new Event("change"));
        expect(chrome.permissions.request).toHaveBeenCalledWith({
            origins: MEETING_PROMPT_ORIGINS,
        });
        await vi.waitFor(() =>
            expect(inputs.every((input) => input.checked)).toBe(true),
        );
        inputs[1].checked = false;
        inputs[1].dispatchEvent(new Event("change"));
        expect(chrome.permissions.remove).toHaveBeenCalledWith({
            origins: MEETING_PROMPT_ORIGINS,
        });
        await vi.waitFor(() =>
            expect(
                inputs.every((input) => !input.checked && !input.disabled),
            ).toBe(true),
        );
        granted = true;
        await events.added();
        expect(inputs.every((input) => input.checked)).toBe(true);
        granted = false;
        await events.removed();
        expect(inputs.every((input) => !input.checked)).toBe(true);
    });
    it("restores the switch and shows the denial text when Chrome refuses access", async () => {
        document.body.innerHTML =
            '<input id="switch" type="checkbox"><p id="status"></p>';
        const input = document.getElementById("switch");
        const status = document.getElementById("status");
        await bindMeetingPromptSwitches([input], status);
        chrome.permissions.request.mockResolvedValue(false);
        input.checked = true;
        input.dispatchEvent(new Event("change"));
        await vi.waitFor(() =>
            expect(status.textContent).toBe("meetingPromptAccessDenied"),
        );
        expect(input.checked).toBe(false);
    });
});
