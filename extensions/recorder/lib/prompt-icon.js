const PREFIX = "prompt-icon:";
const BLINK_MS = 20_000;
const FRAME_MS = 600;
const ICON_PATHS = {
    16: "icons/icon-16.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
};

async function buildFrames() {
    const normal = {};
    const highlighted = {};
    await Promise.all([
        [16, ICON_PATHS[16]],
        [32, ICON_PATHS[48]],
    ].map(async ([size, path]) => {
        const response = await fetch(chrome.runtime.getURL(path));
        const logo = await createImageBitmap(await response.blob());
        try {
            const canvas = new OffscreenCanvas(size, size);
            const ctx = canvas.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(logo, 0, 0, size, size);
            normal[size] = ctx.getImageData(0, 0, size, size);
            ctx.clearRect(0, 0, size, size);
            ctx.fillStyle = "#f35f6d";
            ctx.beginPath();
            ctx.roundRect(0, 0, size, size, size / 4);
            ctx.fill();
            const inset = size / 8;
            ctx.drawImage(logo, inset, inset, size - 2 * inset, size - 2 * inset);
            highlighted[size] = ctx.getImageData(0, 0, size, size);
        } finally {
            logo.close();
        }
    }));
    return { normal, highlighted };
}

async function setIcon(tabId, icon) {
    try {
        await chrome.action.setIcon({ tabId, ...icon });
        return true;
    } catch {
        return false;
    }
}

/** Blink once per visible, pinned prompt and repair tab overrides on every worker wake. */
export function createPromptIconBlink(sessionLoaded, clearBlinkCopy, { paintBadge, restoreBadge }) {
    const prompts = new Map();
    let frames;
    const restored = sessionLoaded.then(async (stored) => {
        await Promise.all(Object.keys(stored || {}).filter((key) => key.startsWith(PREFIX)).map(async (key) => {
            const tabId = Number(key.slice(PREFIX.length));
            const entry = stored.armedTabs?.[tabId];
            await setIcon(tabId, { path: ICON_PATHS });
            await restoreBadge(tabId);
            if (entry?.promptVisible || entry?.bannerPrompt) {
                const record = stored[key];
                const used = typeof record === "object" && record !== null ? record.used === true : Boolean(record);
                if (used) prompts.set(tabId, { used: true, restored: true });
                else await chrome.storage.session.remove(key);
                await clearBlinkCopy(tabId, record?.until ?? (typeof record === "number" ? record : null));
            } else await chrome.storage.session.remove(key);
        }));
    }).catch(() => {});

    async function prepare(tabId, blink) {
        try {
            blink.icons = await (frames ??= buildFrames());
        } catch {
            frames = undefined;
            return;
        }
        if (prompts.get(tabId) !== blink) return;
        blink.until = Date.now() + BLINK_MS;
        try {
            // Persist before sending the deadline so a new worker can repair both the icon and copy.
            await chrome.storage.session.set({ [`${PREFIX}${tabId}`]: { until: blink.until, used: false } });
        } catch {
            blink.until = null;
        }
    }

    async function reserve(tabId, isCurrent) {
        await restored;
        if (!isCurrent() || !chrome.action.setIcon || typeof OffscreenCanvas === "undefined") return null;
        let blink = prompts.get(tabId);
        if (!blink) {
            blink = {};
            prompts.set(tabId, blink);
            blink.ready = prepare(tabId, blink);
        }
        await blink.ready;
        return prompts.get(tabId) === blink && !blink.failed && Date.now() < blink.until ? blink : null;
    }

    function start(tabId, blink) {
        if (!blink || blink.started || prompts.get(tabId) !== blink || Date.now() >= blink.until) return;
        blink.started = true;
        const isCurrent = () => prompts.get(tabId) === blink;
        const finish = async () => {
            blink.finished = true;
            await setIcon(tabId, { path: ICON_PATHS });
            if (isCurrent()) await restoreBadge(tabId, isCurrent);
        };
        let highlighted = true;
        const tick = async () => {
            if (!isCurrent()) return;
            if (Date.now() >= blink.until) {
                await finish();
                return;
            }
            const painted = await setIcon(tabId, { imageData: highlighted ? blink.icons.highlighted : blink.icons.normal });
            if (!isCurrent()) return;
            if (!painted) {
                blink.failed = true;
                await Promise.all([finish(), clearBlinkCopy(tabId, blink.until)]);
                return;
            }
            if (!blink.used) {
                blink.used = true;
                await chrome.storage.session.set({ [`${PREFIX}${tabId}`]: { until: blink.until, used: true } }).catch(() => {});
                if (!isCurrent()) return;
            }
            await paintBadge(tabId, highlighted, isCurrent);
            if (!isCurrent()) return;
            highlighted = !highlighted;
            blink.timer = setTimeout(tick, Math.min(FRAME_MS, blink.until - Date.now()));
        };
        void tick();
    }

    function isBlinking(tabId) {
        const blink = prompts.get(tabId);
        return Boolean(blink?.started && !blink.finished);
    }

    async function stop(tabId, updateCopy = false, keepWindow = false) {
        if (!prompts.has(tabId)) await restored;
        const blink = prompts.get(tabId);
        if (!blink || (keepWindow && blink.paused)) return;
        const used = keepWindow && blink.used;
        if (used) prompts.set(tabId, { used: true, restored: true, paused: true });
        else prompts.delete(tabId);
        clearTimeout(blink.timer);
        if (!blink.until && !blink.restored) return;
        await Promise.all([
            setIcon(tabId, { path: ICON_PATHS }),
            ...(blink.started || blink.restored ? [restoreBadge(tabId, () => !isBlinking(tabId))] : []),
            ...(updateCopy && blink.until ? [clearBlinkCopy(tabId, blink.until)] : []),
        ]);
        if (!prompts.has(tabId)) await chrome.storage.session.remove(`${PREFIX}${tabId}`).catch(() => {});
    }

    return { reserve, start, stop, isBlinking, pause: (tabId) => stop(tabId, false, true) };
}
