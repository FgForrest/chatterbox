// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RecordPicker } from "@/components/almanac/record-picker";

const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/people") {
        return Response.json({
            people: [
                { id: "colleague", displayName: "Ema Bílá", scope: "personal" },
                {
                    id: "viewer",
                    displayName: "Jitka Žulová",
                    scope: "org",
                    self: true,
                },
            ],
        });
    }
    return Response.json({
        entities: [
            {
                id: "company",
                name: "Acme Research",
                typeKey: "company",
                scope: "org",
            },
        ],
    });
});

beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it("pins the viewer and searches Almanac people by surname in people mode", async () => {
    const onPick = vi.fn();
    render(<RecordPicker kind="person" onPick={onPick} />);
    await screen.findByText("Ema Bílá");
    expect(screen.getAllByRole("option")[0].textContent).toContain(
        "Jitka Žulová",
    );
    expect(fetchMock).not.toHaveBeenCalledWith("/api/knowledge/entities");
    fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "BILA" },
    });
    fireEvent.click(screen.getByRole("option"));
    expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({
            id: "colleague",
            kind: "person",
            typeKey: "person",
        }),
    );
});

it("can still pick a thing in mixed mode while excluding the source person", async () => {
    const onPick = vi.fn();
    render(
        <RecordPicker
            types={["person", "company"]}
            exclude="viewer"
            onPick={onPick}
        />,
    );
    await screen.findByText("Acme Research");
    expect(screen.queryByText("Jitka Žulová")).toBeNull();
    expect(screen.getByText("Ema Bílá")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), {
        target: { value: "Research" },
    });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({
            id: "company",
            kind: "entity",
            typeKey: "company",
        }),
    );
});
