// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssigneePicker } from "@/components/tasks/assignee-picker";

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

it("pins the viewer before the recording speakers, checks the current choice and unassigns", async () => {
    const onChange = vi.fn();
    vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
            Response.json({
                people: [
                    {
                        id: "other",
                        displayName: "Ema Bílá",
                        scope: "org",
                        primaryEmail: null,
                    },
                    {
                        id: "private",
                        displayName: "Sára Bílá",
                        scope: "personal",
                        self: true,
                    },
                    {
                        id: "speaker",
                        displayName: "Vít Zelený",
                        scope: "org",
                        primaryEmail: "vit@example.test",
                    },
                    {
                        id: "me",
                        displayName: "Jitka Žulová",
                        scope: "org",
                        self: true,
                        primaryEmail: "jitka@example.test",
                    },
                ],
            }),
        ),
    );
    render(
        <AssigneePicker
            value={{ personId: "speaker", name: "Vít Zelený" }}
            check
            speakers={[
                { personId: "private", name: "Sára Bílá" },
                { personId: "speaker", name: "Vít Zelený" },
            ]}
            organizationOnly
            onChange={onChange}
        />,
    );
    const trigger = screen.getByRole("combobox", {
        name: "Assigned to Vít Zelený",
    });
    expect(trigger.getAttribute("title")).toBe(
        "Matched by first name only. Check who it is.",
    );
    fireEvent.click(trigger);

    await screen.findByText("Jitka Žulová");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.getAttribute("data-value"))).toEqual([
        "person:me",
        "person:speaker",
        "person:other",
        "entry:nobody",
    ]);
    const group = screen.getByRole("group", { name: "In this recording" });
    expect(within(group).getByRole("option").getAttribute("aria-checked")).toBe(
        "true",
    );
    expect(screen.getByText("no email")).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: "Nobody" }));
    expect(onChange).toHaveBeenCalledWith(null);
});
