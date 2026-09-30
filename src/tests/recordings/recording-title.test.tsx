// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingTitle } from "@/components/recordings/recording-title";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("recording title", () => {
    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    async function rename(view?: "org") {
        const fetch = vi
            .fn()
            .mockResolvedValue(Response.json({ filename: "Curated" }));
        vi.stubGlobal("fetch", fetch);
        const onRenamed = vi.fn();
        render(
            <RecordingTitle
                recordingId="rec-1"
                filename="Weekly"
                view={view}
                onRenamed={onRenamed}
            />,
        );
        fireEvent.click(screen.getByRole("button", { name: "Rename Weekly" }));
        const input = screen.getByRole("textbox", { name: "Recording name" });
        fireEvent.change(input, { target: { value: "Curated" } });
        fireEvent.keyDown(input, { key: "Enter" });
        await waitFor(() => expect(onRenamed).toHaveBeenCalledWith("Curated"));
        return fetch.mock.calls[0]?.[0];
    }

    it("renames on the Organization view there, for the curator", async () => {
        expect(await rename("org")).toBe("/api/recordings/rec-1?view=org");
    });

    it("renames on the owner's own view otherwise", async () => {
        expect(await rename()).toBe("/api/recordings/rec-1");
    });

    it("offers no rename when read-only", () => {
        render(
            <RecordingTitle recordingId="rec-1" filename="Weekly" readOnly />,
        );
        expect(screen.queryByRole("button")).toBeNull();
    });
});
