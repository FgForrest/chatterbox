import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
    captureAgendaTitleKey,
    captureHasGap,
} from "../../../extensions/recorder/lib/capture-state.js";

const source = readFileSync("extensions/recorder/options/options.js", "utf8");
const catalog = (locale) =>
    JSON.parse(
        readFileSync(
            `extensions/recorder/_locales/${locale}/messages.json`,
            "utf8",
        ),
    );

function options(
    locale = "en",
    {
        meta: metaPatch = {},
        other = false,
        confirm = () => true,
        session = {},
    } = {},
) {
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
        captureAgendaTitleKey,
        captureHasGap,
        t,
        document: { createElement: node },
        chrome: {
            runtime: { sendMessage },
            storage: { session: { get: async () => ({ ...session }) } },
        },
        getSettings: async () => ({ hasApiKey: true }),
        serverUnavailable: async () => false,
        pendingRecordingBytes: async () => 12_000_000,
        formatBufferedBytes: () => "12 MB",
        pendingRecordingStatus: () => ({
            title: t("offlineWaiting"),
            local: !other,
            other,
        }),
        window: { confirm },
        serverSessionFor: (meta) => meta.serverSessionId,
        listPendingCaptures: async () =>
            ids.map((id) => ({
                id,
                meta: {
                    serverUrl: "https://recorder.example",
                    startedAt: "2026-11-10T10:00:00Z",
                    ...metaPatch,
                },
            })),
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
        const [retry, check, discard] = item.children[3].children;
        return { retry, check, discard, status: item.children[4] };
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
    it.each([
        ["en", "Part of the recording is missing."],
        ["cs", "Část nahrávky chybí."],
    ])("shows the gap and offers a confirmed playable beginning in %s", async (locale, missing) => {
        const confirm = vi
            .fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const h = options(locale, {
            meta: {
                verifiedPrefix: 0,
                highestCommittedIndex: 2,
                chunkCount: 3,
            },
            confirm,
        });
        await h.render();
        const item = h.el("pending-buffer-list").children[0];
        expect(item.children[2].textContent).toContain(missing);
        const save = item.children[3].children.find(
            (child) => child.textContent === h.t("savePlayablePrefix"),
        );
        expect(save.hidden).toBeFalsy();
        await save.events.click();
        expect(h.sendMessage).not.toHaveBeenCalled();
        await save.events.click();
        expect(confirm).toHaveBeenCalledWith(h.t("savePlayablePrefixConfirm"));
        expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
            type: "save-buffer-prefix",
            bufferId: "buffer-one",
        });
    });

    it("shows the session agenda title, then falls back to the start time when it is cleared", async () => {
        const key = captureAgendaTitleKey("buffer-one");
        const session = {
            [key]: { agendaId: "agenda-one", title: "Planning" },
        };
        const h = options("en", {
            session,
            meta: { agendaId: "agenda-one", agendaTitle: "Old disk title" },
        });
        const label = () =>
            h.el("pending-buffer-list").children[0].children[0].textContent;
        await h.render();
        expect(label()).toBe("Planning");
        delete session[key];
        await h.render();
        expect(label()).toBe(new Date("2026-11-10T10:00:00Z").toLocaleString());
    });

    it("uses Chatterbox for English offline copy and Klepna for Czech", () => {
        const en = catalog("en");
        const cs = catalog("cs");
        expect(en.offlineIdle.message).toContain("Chatterbox");
        expect(en.offlineOtherConnection.message).not.toContain("Klepna");
        expect(cs.offlineOtherConnection.message).toContain("Klepny");
    });
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
                schedulePendingBuffers: vi.fn(),
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

    it("keeps a second retry neutral when re-rendered after a failed attempt", async () => {
        const h = options();
        h.sendMessage.mockResolvedValueOnce({
            ok: false,
            error: h.t("requestTimedOut"),
        });
        await h.render();
        await h.row().retry.events.click();
        expect(h.row().status.className).toBe("status err");
        let finish;
        h.sendMessage.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = h.row().retry.events.click();
        expect(h.row().status.textContent).toBe(h.t("retryBufferRunning"));
        expect(h.row().status.className).toBe("status ok");
        await h.render();
        const { retry, check, discard, status } = h.row();
        expect(retry.disabled).toBe(true);
        expect(check.disabled).toBe(true);
        expect(discard.disabled).toBe(true);
        expect(status.textContent).toBe(h.t("retryBufferRunning"));
        const runningClass = status.className;
        finish({ ok: true });
        await pending;
        expect(runningClass).toBe("status ok");
        expect(h.row().status.textContent).toBe(h.t("retryBufferResumed"));
        expect(h.row().status.className).toBe("status ok");
    });

    it("discards a checked buffer and removes its row after re-rendering", async () => {
        const h = options();
        h.sendMessage.mockImplementationOnce(async () => {
            h.remove();
            return { ok: true };
        });
        await h.render();
        const { check, discard } = h.row();
        expect(discard.disabled).toBe(true);
        check.checked = true;
        check.events.change();
        expect(discard.disabled).toBe(false);
        await discard.events.click();
        expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
            type: "discard-buffer",
            bufferId: "buffer-one",
        });
        expect(h.el("pending-buffer-list").children).toEqual([]);
        expect(h.el("pending-buffers").hidden).toBe(true);
        expect(h.el("manual-recovery-label").hidden).toBe(true);
    });

    it("keeps the row and shows the error near the list when discard fails", async () => {
        const h = options();
        const error = h.t("somethingWrong");
        h.sendMessage.mockResolvedValueOnce({ ok: false, error });
        await h.render();
        const item = h.el("pending-buffer-list").children[0];
        const { check, discard } = h.row();
        check.checked = true;
        check.events.change();
        expect(discard.disabled).toBe(false);
        await discard.events.click();
        expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith({
            type: "discard-buffer",
            bufferId: "buffer-one",
        });
        expect(h.el("pending-buffer-list").children).toEqual([item]);
        expect(h.el("pending-buffers").hidden).toBe(false);
        expect(h.el("pending-discard-status").textContent).toBe(error);
        expect(h.el("pending-discard-status").className).toBe("status err");
    });

    it.each([
        ["en", "The recording was already saved in Chatterbox."],
        ["cs", "Nahrávka už byla uložena v Klepně."],
    ])("shows that finalization won after the last row is removed in %s", async (locale, text) => {
        const h = options(locale);
        h.sendMessage.mockImplementationOnce(async () => {
            h.remove();
            await h.render();
            return { ok: false, error: h.t("discardAlreadySaved") };
        });
        await h.render();
        const { check, discard } = h.row();
        check.checked = true;
        check.events.change();
        await discard.events.click();
        expect(h.el("pending-buffers").hidden).toBe(true);
        expect(h.el("pending-discard-status").textContent).toBe(text);
    });

    it("shows only Discard for another account, with confirmation before removing a local-only buffer", async () => {
        const confirm = vi
            .fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const h = options("en", {
            meta: { protocol: 2, serverSessionId: null },
            other: true,
            confirm,
        });
        await h.render();
        const { retry, check, discard } = h.row();
        expect(retry.hidden).toBe(true);
        expect(check.hidden).toBe(true);
        expect(discard.disabled).toBe(false);
        await discard.events.click();
        expect(h.sendMessage).not.toHaveBeenCalled();
        await discard.events.click();
        expect(h.sendMessage).toHaveBeenCalledWith({
            type: "discard-buffer",
            bufferId: "buffer-one",
        });
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
