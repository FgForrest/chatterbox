import { afterEach, describe, expect, it, vi } from "vitest";
import { fitWindowToContent } from "../../../extensions/recorder/lib/fit-window.js";

function setup({
    content,
    inner,
    height = 360,
    state = "normal",
    avail = 1000,
}) {
    let onContentResize;
    let onResize;
    const frames = [];
    const page = { content, inner };
    const update = vi.fn(async () => ({}));
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback) {
                onContentResize = callback;
            }
            observe() {}
        },
    );
    vi.stubGlobal("requestAnimationFrame", (callback) => frames.push(callback));
    vi.stubGlobal("screen", { availHeight: avail });
    vi.stubGlobal("document", {
        body: {},
        documentElement: {
            getBoundingClientRect: () => ({ height: page.content }),
        },
    });
    vi.stubGlobal("window", {
        get innerHeight() {
            return page.inner;
        },
        addEventListener: (event, listener) => {
            if (event === "resize") onResize = listener;
        },
    });
    vi.stubGlobal("chrome", {
        windows: {
            getCurrent: vi.fn(async () => ({ id: 9, height, state })),
            update,
        },
    });
    fitWindowToContent();
    const flush = async () => {
        for (const frame of frames.splice(0)) frame();
        await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return {
        page,
        update,
        contentResized: () => onContentResize(),
        resize: () => onResize(),
        flush,
    };
}

afterEach(() => vi.unstubAllGlobals());

describe("recorder window fitted to its page", () => {
    it("shrinks the window to the page, including Chrome's own bars", async () => {
        const { update, contentResized, flush } = setup({
            content: 250.4,
            inner: 310,
        });
        contentResized();
        await flush();
        expect(update).toHaveBeenCalledExactlyOnceWith(9, { height: 301 });
    });

    it("grows the window when the page or Chrome's sharing bar takes more room", async () => {
        const { page, update, resize, flush } = setup({
            content: 250,
            inner: 250,
        });
        page.inner = 204;
        resize();
        await flush();
        expect(update).toHaveBeenCalledExactlyOnceWith(9, { height: 406 });
    });

    it("coalesces the triggers of one frame into one resize", async () => {
        const { update, contentResized, resize, flush } = setup({
            content: 200,
            inner: 300,
        });
        contentResized();
        resize();
        contentResized();
        await flush();
        expect(update).toHaveBeenCalledOnce();
    });

    it("leaves a fitting, minimized or maximized window alone", async () => {
        for (const options of [
            { content: 300, inner: 299 },
            { content: 200, inner: 300, state: "minimized" },
            { content: 200, inner: 300, state: "maximized" },
        ]) {
            const { update, contentResized, flush } = setup(options);
            contentResized();
            await flush();
            expect(update).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        }
    });

    it("never grows past the screen", async () => {
        const { update, contentResized, flush } = setup({
            content: 900,
            inner: 300,
            avail: 700,
        });
        contentResized();
        await flush();
        expect(update).toHaveBeenCalledExactlyOnceWith(9, { height: 700 });
    });
});
