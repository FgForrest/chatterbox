// Pairing relay, injected on the paired Riffado origin (and on hosted origins).
//
// Lets the Riffado settings page detect this extension and hand it a recorder
// key without the user touching the extension:
//   page  -> "riffado-recorder-ping"  -> we answer "riffado-recorder-present"
//   page  -> "riffado-recorder-pair"  -> relayed to the service worker, which
//            validates the origin and stores the pair; its answer is relayed
//            back as "riffado-recorder-pair-result".
// Only same-window, same-origin messages are honoured.

(() => {
    if (window.__riffadoRecorderRelay) return;
    window.__riffadoRecorderRelay = true;

    const PING = "riffado-recorder-ping";
    const PRESENT = "riffado-recorder-present";
    const PAIR = "riffado-recorder-pair";
    const PAIR_RESULT = "riffado-recorder-pair-result";

    function post(data) {
        window.postMessage(data, location.origin);
    }

    async function status() {
        try {
            const reply = await chrome.runtime.sendMessage({ type: PING });
            return reply ?? { installed: true };
        } catch {
            return { installed: true, unreachable: true };
        }
    }

    // Announce on load so a page already listening updates immediately.
    status().then((s) => post({ type: PRESENT, channel: "content", ...s }));

    window.addEventListener("message", async (event) => {
        if (event.source !== window || event.origin !== location.origin) return;
        const data = event.data;
        if (!data || typeof data.type !== "string") return;

        if (data.type === PING) {
            const s = await status();
            post({ type: PRESENT, channel: "content", ...s });
            return;
        }

        if (data.type === PAIR) {
            if (
                typeof data.serverUrl !== "string" ||
                typeof data.apiKey !== "string"
            ) {
                return;
            }
            let result;
            try {
                result = await chrome.runtime.sendMessage({
                    type: PAIR,
                    serverUrl: data.serverUrl,
                    apiKey: data.apiKey,
                });
            } catch (error) {
                result = { ok: false, error: String(error) };
            }
            post({ type: PAIR_RESULT, ...(result ?? { ok: false }) });
        }
    });
})();
