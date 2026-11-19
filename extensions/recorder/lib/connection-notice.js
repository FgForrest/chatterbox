import { t } from "./i18n.js";
import { connectionNotice, readServerConnection, SERVER_CONNECTION_KEY } from "./server-connection.js";

function probe() {
    return chrome.runtime.sendMessage({ type: "recorder-connection-retry" });
}

/** Watch the pairing's connection and ask the worker to probe while this page is open. */
export function watchServerConnection(render, { watchPage = true } = {}) {
    let version = 0;
    async function refresh() {
        const current = ++version;
        const connection = await readServerConnection();
        if (current === version) render(connection);
    }
    function changed(changes, area) {
        if ((area === "session" && changes[SERVER_CONNECTION_KEY]) ||
            (area === "local" && (changes.serverUrl || changes.encryptedApiKey || changes.dataUseAcknowledgedAt))) {
            void refresh().catch(() => {});
        }
    }
    const online = () => void probe().catch(() => {});
    chrome.storage.onChanged.addListener(changed);
    if (watchPage) {
        window.addEventListener("online", online);
        void chrome.runtime.sendMessage({ type: "recorder-connection-watch" }).catch(() => {});
    }
    const destroy = () => {
        version++;
        chrome.storage.onChanged.removeListener?.(changed);
        if (watchPage) window.removeEventListener("online", online);
    };
    return { ready: refresh(), destroy };
}

/** Render the connection status and an immediate retry in an extension page. */
export function mountConnectionNotice(anchor, options = {}) {
    const { onConnection, ...initialContext } = options;
    let context = initialContext;
    let connection;
    const box = document.createElement("div");
    box.className = "connection-notice";
    box.hidden = true;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const message = document.createElement("strong");
    const detail = document.createElement("div");
    const extra = document.createElement("div");
    status.append(message, detail, extra);
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = t("connectionRetry");
    retry.addEventListener("click", async () => {
        retry.disabled = true;
        try { await probe(); }
        catch {}
        finally { retry.disabled = false; }
    });
    box.append(status, retry);
    anchor.before(box);
    function render() {
        const copy = connectionNotice(connection, context);
        box.hidden = !copy;
        if (!copy) return;
        if (message.textContent !== copy.message) message.textContent = copy.message;
        if (detail.textContent !== copy.detail) detail.textContent = copy.detail;
        if (extra.textContent !== (copy.context ?? "")) extra.textContent = copy.context ?? "";
    }
    const watcher = watchServerConnection((value) => {
        connection = value;
        render();
        onConnection?.(value);
    });
    return {
        ready: watcher.ready,
        update(next) {
            context = next;
            render();
        },
        destroy: watcher.destroy,
    };
}
