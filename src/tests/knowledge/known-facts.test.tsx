// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KnownFacts, OtherNames } from "@/components/people/known-facts";
import type { PageRelation } from "@/lib/knowledge/fact-page";

const relations: PageRelation[] = [
    {
        key: "leads",
        label: "leads",
        facts: [
            {
                id: "f-1",
                direction: "subject",
                other: { kind: "entity", id: "orion", text: "Orion" },
                scope: "org",
                origin: "recording",
                evidence: [
                    {
                        recordingId: "rec-2",
                        title: "June sync",
                        recordedAt: "2026-06-14T09:00:00.000Z",
                        startMs: 125_000,
                        view: "org",
                    },
                    {
                        recordingId: "rec-1",
                        title: "Weekly",
                        recordedAt: "2026-03-03T12:04:00.000Z",
                        startMs: 724_000,
                        view: "private",
                    },
                ],
            },
        ],
    },
    {
        key: "reports_to",
        label: "reports to",
        facts: [
            {
                id: "f-2",
                direction: "object",
                other: { kind: "person", id: "pavel", text: "Pavel" },
                scope: "personal",
                origin: "manual",
                evidence: [],
            },
        ],
    },
];

describe("KnownFacts", () => {
    afterEach(cleanup);

    it("reads each fact from the page's side, with who else it names", () => {
        render(<KnownFacts name="Jan" relations={relations} />);
        expect(screen.getByRole("heading", { name: "leads" })).toBeDefined();
        expect(
            screen.getByRole("heading", { name: "reports to Jan" }),
        ).toBeDefined();
        expect(
            screen.getByRole("link", { name: /Orion/ }).getAttribute("href"),
        ).toBe("/people/entities/orion");
        expect(
            screen.getByRole("link", { name: /Pavel/ }).getAttribute("href"),
        ).toBe("/people/pavel");
    });

    it("counts the recordings a fact was said in, and links to each moment", () => {
        render(<KnownFacts name="Jan" relations={relations} />);
        expect(screen.getByText(/Supported by 2 recordings/)).toBeDefined();
        expect(screen.getByText(/Entered by hand/)).toBeDefined();
        const june = screen.getByRole("link", { name: /June sync 2:05/ });
        expect(june.getAttribute("href")).toBe(
            "/dashboard?recording=rec-2&view=org",
        );
        expect(
            screen
                .getByRole("link", { name: /Weekly 12:04/ })
                .getAttribute("href"),
        ).toBe("/recordings/rec-1");
    });

    it("says when nothing is known", () => {
        render(<KnownFacts name="Jan" relations={[]} />);
        expect(screen.getByText("Nothing is known yet.")).toBeDefined();
    });
});

describe("OtherNames", () => {
    afterEach(cleanup);

    it("lists aliases and how transcription heard the name", () => {
        render(
            <OtherNames
                names={[
                    { text: "Honza", kind: "alias" },
                    { text: "Novák", kind: "heard_as" },
                ]}
            />,
        );
        expect(screen.getByText(/Honza/)).toBeDefined();
        expect(screen.getByText(/heard as Novák/)).toBeDefined();
    });

    it("shows nothing without other names", () => {
        const { container } = render(<OtherNames names={[]} />);
        expect(container.textContent).toBe("");
    });
});
