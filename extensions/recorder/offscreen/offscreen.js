import { CHANNEL_LAYOUT_MIXED } from "../lib/constants.js";
import { createCaptureHost } from "../lib/capture-host.js";

const capture = createCaptureHost();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== "offscreen") return false;
    if (message.type === "start") {
        capture.start(message.payload)
            .then(() => sendResponse({ ok: true }))
            .catch((error) =>
                sendResponse({ ok: false, error: error?.message ?? String(error) }),
            );
        return true;
    }
    if (message.type === "stop") {
        capture.stop();
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "ping") {
        sendResponse({ ok: true, recording: capture.isRecording() });
        return false;
    }
    return false;
});

chrome.runtime.sendMessage({
    type: "offscreen-ready",
    channelLayout: CHANNEL_LAYOUT_MIXED,
}).catch(() => {});
