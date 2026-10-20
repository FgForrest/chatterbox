// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { NewRecordItem } from "@/components/learn/new-record-item";

afterEach(cleanup);

it("keeps an edited new-record name when it is ticked before the blur save returns", () => {
    const onDecide = vi.fn(() => new Promise<void>(() => {}));
    render(
        createElement(NewRecordItem, {
            payload: {
                ref: "n1",
                kind: "entity",
                typeKey: "organization",
                name: "CHVEX",
                evidenceMs: [0],
                reason: "Klient.",
            },
            choice: null,
            ticked: false,
            rejected: false,
            disabled: false,
            names: {},
            entityTypes: [{ key: "organization", label: "Organization" }],
            seek: () => null,
            onDecide,
            onLinked: vi.fn(),
        }),
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(input, { target: { value: "ČVEX" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(onDecide.mock.calls).toEqual([
        ["accepted", { name: "ČVEX", typeKey: "organization" }],
        ["accepted", { name: "ČVEX", typeKey: "organization" }],
    ]);
});
