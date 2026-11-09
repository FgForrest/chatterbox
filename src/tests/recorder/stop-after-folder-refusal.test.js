// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as bundle from "../../../extensions/recorder/bundle/folders.jsx";
import { STATE } from "../../../extensions/recorder/lib/constants.js";
import { mountRecordingControls } from "../../../extensions/recorder/lib/recording-controls.js";

vi.mock("../../../extensions/recorder/generated/folders.js", () => ({
    createFolderField: (...args) => bundle.createFolderField(...args),
    createRecordingFolder: (...args) => bundle.createRecordingFolder(...args),
}));

const catalog = JSON.parse(
    readFileSync("extensions/recorder/_locales/en/messages.json", "utf8"),
);
const t = (key, substitution = "") =>
    (catalog[key]?.message ?? key).replace("$1", substitution);
const state = {
    state: "recording",
    sessionId: "one",
    pickerRequestId: "request-1",
    startedAt: new Date().toISOString(),
    uploaded: [],
    folderId: "work",
    folderLabel: "Organization / Planning",
    folderScope: "org",
    recordingFolderOverride: true,
};
let widget;
let pickerFolder;
let listener;
let send;
beforeEach(() => {
    vi.useFakeTimers();
    send = vi.fn(async (message) => {
        if (message.type === "get-state") return { state };
        if (message.type === "get-folders") return { ok: true, folders: [] };
        if (message.type === "set-recording-folder")
            return { ok: false, error: "Folder save refused" };
        return { ok: true };
    });
    vi.stubGlobal("chrome", {
        i18n: { getMessage: t, getUILanguage: () => "en" },
        runtime: {
            getURL: (path) => `chrome-extension://test/${path}`,
            sendMessage: send,
            onMessage: {
                addListener: (fn) => {
                    listener = fn;
                },
                removeListener: vi.fn(),
            },
        },
        storage: {
            local: {
                get: async () => ({
                    serverUrl: "https://recorder.example.com",
                    encryptedApiKey: { nonce: [1] },
                    dataUseAcknowledgedAt: "now",
                }),
                set: vi.fn(async () => {}),
            },
            onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        },
        tabs: { query: async () => [{ id: 8, url: "https://example.com" }] },
        desktopCapture: { chooseDesktopMedia: vi.fn() },
    });
    vi.stubGlobal("navigator", {
        permissions: { query: async () => ({ state: "granted" }) },
    });
});
afterEach(async () => {
    await act(async () => {
        widget?.destroy();
        pickerFolder?.destroy();
    });
    widget = undefined;
    pickerFolder = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
});

async function refuseThenStop(container, stopId, message) {
    const remove = container.querySelector(
        'button[aria-label="Remove from Planning"]',
    );
    expect(remove).toBeTruthy();
    await act(async () => remove.click());
    expect(send).toHaveBeenCalledWith({
        type: "set-recording-folder",
        sessionId: "one",
        folderId: null,
        folderLabel: null,
        folderScope: null,
    });
    expect(container.textContent).toContain("Folder save refused");
    expect(
        container.querySelector(".recorder-folder-target button").textContent,
    ).toBe("Planning");
    await act(async () => document.getElementById(stopId).click());
    expect(send).toHaveBeenCalledWith(message);
}

it.each([
    "popup",
    "panel",
])("sends stop-recording from %s after the real bundled folder save is refused", async (variant) => {
    document.documentElement.innerHTML = readFileSync(
        "extensions/recorder/popup/popup.html",
        "utf8",
    );
    await act(async () => {
        widget = await mountRecordingControls(document.body, { variant });
    });
    await refuseThenStop(
        document.getElementById("recording-folder-row"),
        "stop",
        { type: "stop-recording", reason: "user" },
    );
});

it("sends stop-recording from the picker after the real bundled folder save is refused", async () => {
    document.documentElement.innerHTML = readFileSync(
        "extensions/recorder/picker/picker.html",
        "utf8",
    );
    vi.stubGlobal("location", {
        href: "https://example.com/picker?requestId=request-1",
    });
    const source = readFileSync(
        "extensions/recorder/picker/picker.js",
        "utf8",
    ).replace(/^import[\s\S]*?from "[^"]+";\s*/gm, "");
    new Function(
        "createCaptureHost",
        "openSystemAudio",
        "RECORDER_WINDOW_WIDTH",
        "STATE",
        "fitWindowToContent",
        "localizeDocument",
        "t",
        "createRecordingFolder",
        source,
    )(
        () => ({}),
        vi.fn(),
        430,
        STATE,
        vi.fn(),
        vi.fn(),
        t,
        (options) => {
            pickerFolder = bundle.createRecordingFolder(options);
            return pickerFolder;
        },
    );
    await act(async () => listener({ type: "state", state }));
    await refuseThenStop(
        document.getElementById("picker-folder-row"),
        "picker-stop",
        { type: "stop-recording" },
    );
});
