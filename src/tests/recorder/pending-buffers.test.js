import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync("extensions/recorder/options/options.js", "utf8");
const catalog = (locale) =>
    JSON.parse(
        readFileSync(
            `extensions/recorder/_locales/${locale}/messages.json`,
            "utf8",
        ),
    );

function options(locale = "en") {
    const messages = catalog(locale);
    const t = (key) => messages[key]?.message ?? key;
    const nodes = new Map();
    function node() {
        return {
            children: [],
            attrs: {},
            events: {},
            checked: false,
            append(...children) {
                this.children.push(...children);
            },
            replaceChildren(...children) {
                this.children = children;
            },
            setAttribute(name, value) {
                this.attrs[name] = value;
            },
            addEventListener(type, listener) {
                this.events[type] = listener;
            },
        };
    }
    const el = (id) => {
        if (!nodes.has(id)) nodes.set(id, node());
        return nodes.get(id);
    };
    let ids = ["buffer-one"];
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const ctx = {
        el,
        t,
        document: { createElement: node },
        chrome: { runtime: { sendMessage } },
        listLocalSessions: async () => ids,
        readLocalMeta: async () => ({
            serverUrl: "https://recorder.example",
            startedAt: "2026-11-10T10:00:00Z",
        }),
        setStatus: (node, message, ok) => {
            node.textContent = message;
            node.className = `status ${ok ? "ok" : "err"}`;
        },
    };
    vm.runInNewContext(
        source.slice(
            source.indexOf("const pendingBufferRetries"),
            source.indexOf('el("refresh-config").addEventListener'),
        ),
        ctx,
    );
    function row() {
        const item = el("pending-buffer-list").children[0];
        const [retry, check, discard] = item.children[1].children;
        return { retry, check, discard, status: item.children[2] };
    }
    return {
        render: ctx.renderPendingBuffers,
        row,
        sendMessage,
        el,
        t,
        remove: () => {
            ids = [];
        },
    };
}

describe("pending recording retry controls", () => {
    it("refreshes on lifecycle changes without rebuilding rows for audio levels or chunk progress", () => {
        let changed;
        const refresh = vi.fn();
        vm.runInNewContext(
            source.slice(
                source.indexOf("chrome.storage.onChanged.addListener"),
                source.indexOf("function setStatus"),
            ),
            {
                chrome: {
                    storage: {
                        onChanged: {
                            addListener: (listener) => {
                                changed = listener;
                            },
                        },
                    },
                },
                renderPendingBuffers: refresh,
                PENDING_PAIR_KEY: "pair",
                SETUP_FLOW_KEY: "setup",
            },
        );
        const state = { state: "recording", bufferId: "buffer-one" };
        changed(
            {
                recordingState: {
                    oldValue: state,
                    newValue: {
                        ...state,
                        uploaded: [0],
                        levels: { micDb: -30 },
                    },
                },
            },
            "session",
        );
        expect(refresh).not.toHaveBeenCalled();
        changed(
            {
                recordingState: {
                    oldValue: state,
                    newValue: { ...state, state: "completed" },
                },
            },
            "session",
        );
        expect(refresh).toHaveBeenCalledOnce();
    });

    it.each([
        "en",
        "cs",
    ])("offers a localized retry and announces progress in %s", async (locale) => {
        const h = options(locale);
        await h.render();
        const { retry, check, discard, status } = h.row();
        expect(retry.textContent).toBe(h.t("retryUpload"));
        expect(discard.textContent).toBe(h.t("discard"));
        expect(status.attrs).toEqual({ "aria-live": "polite", role: "status" });
        check.checked = true;
        check.events.change();
        expect(discard.disabled).toBe(false);
        let finish;
        h.sendMessage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = retry.events.click();
        expect(h.sendMessage).toHaveBeenCalledWith({
            type: "retry-buffer",
            bufferId: "buffer-one",
        });
        expect(retry.disabled).toBe(true);
        expect(discard.disabled).toBe(true);
        expect(check.disabled).toBe(true);
        expect(status.textContent).toBe(h.t("retryBufferRunning"));
        await h.render();
        expect(h.row().retry.disabled).toBe(true);
        expect(h.row().discard.disabled).toBe(true);
        finish({ ok: true });
        await pending;
        expect(h.row().retry.disabled).toBe(false);
        expect(h.row().status.textContent).toBe(h.t("retryBufferResumed"));
    });

    it.each([
        "recordingKeyExpired",
        "accessWithdrawn",
        "requestTimedOut",
    ])("shows %s in the row and allows an explicit discard", async (key) => {
        const h = options();
        h.sendMessage.mockResolvedValueOnce({ ok: false, error: h.t(key) });
        await h.render();
        await h.row().retry.events.click();
        const { status, check, discard, retry } = h.row();
        expect(status.textContent).toBe(h.t(key));
        expect(status.className).toBe("status err");
        expect(retry.disabled).toBe(false);
        expect(discard.disabled).toBe(true);
        check.checked = true;
        check.events.change();
        expect(discard.disabled).toBe(false);
    });

    it("refreshes the list when completion removes the buffer", async () => {
        const h = options();
        h.sendMessage.mockImplementationOnce(async () => {
            h.remove();
            return { ok: true };
        });
        await h.render();
        await h.row().retry.events.click();
        expect(h.el("pending-buffer-list").children).toEqual([]);
        expect(h.el("pending-buffers").hidden).toBe(true);
    });
});
