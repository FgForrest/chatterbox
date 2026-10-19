// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import {
    OPEN_WORKFLOW_WIDGET_EVENT,
    openWidget,
} from "@/components/pipeline/workflow-widget";

afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
});

it("scrolls to a widget and dispatches its single open event", () => {
    const host = document.createElement("section");
    host.id = "learn-widget";
    host.scrollIntoView = vi.fn();
    document.body.append(host);
    const reopened = vi.fn();
    window.addEventListener(OPEN_WORKFLOW_WIDGET_EVENT, reopened, {
        once: true,
    });
    openWidget("learn-widget");

    expect(host.scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "start",
    });
    expect(reopened).toHaveBeenCalledOnce();
    expect(reopened.mock.calls[0]?.[0]).toMatchObject({
        detail: { id: "learn-widget" },
    });
});
