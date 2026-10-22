// @vitest-environment jsdom

import {
    cleanup,
    fireEvent,
    render,
    screen,
    waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntityActions } from "@/components/almanac/entity-actions";
import { PersonActions } from "@/components/people/person-actions";
import { VocabularyList } from "@/components/people/vocabulary-list";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
    vi.stubGlobal(
        "ResizeObserver",
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
            Response.json(
                url === "/api/people"
                    ? {
                          people: [
                              {
                                  id: "first",
                                  displayName: "Šimon Vlček",
                                  primaryEmail: "first@example.test",
                                  scope: "org",
                              },
                              {
                                  id: "second",
                                  displayName: "Šimon Vlček",
                                  primaryEmail: "second@example.test",
                                  scope: "personal",
                              },
                              {
                                  id: "other",
                                  displayName: "Lada Vlníková",
                                  primaryEmail: null,
                                  scope: "personal",
                              },
                          ],
                      }
                    : url.startsWith("/api/knowledge/entities")
                      ? {
                            entities: [
                                { id: "first", name: "Šimonov", scope: "org" },
                                {
                                    id: "second",
                                    name: "Šimonov",
                                    scope: "personal",
                                },
                                {
                                    id: "other",
                                    name: "Ladov",
                                    scope: "personal",
                                },
                            ],
                        }
                      : { count: 0 },
            ),
        ),
    );
});

afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
});

async function open(mode: "person" | "entity" | "vocabulary") {
    if (mode === "person")
        render(
            <PersonActions
                person={{
                    id: "source",
                    displayName: "Source",
                    primaryEmail: null,
                }}
            />,
        );
    else if (mode === "entity")
        render(
            <EntityActions
                entity={{
                    id: "source",
                    name: "Source",
                    scope: "personal",
                    typeKey: "term",
                    description: null,
                    notes: null,
                }}
                canManage
                types={[]}
            />,
        );
    else
        render(
            <VocabularyList
                types={[
                    {
                        kind: "entity",
                        key: "source",
                        label: "Source",
                        adoptedFromShare: false,
                        uses: 0,
                    },
                ]}
                targets={[
                    {
                        kind: "entity",
                        key: "first",
                        label: "Šimonov",
                        core: true,
                    },
                    {
                        kind: "entity",
                        key: "second",
                        label: "Šimonov",
                        core: false,
                    },
                    {
                        kind: "entity",
                        key: "other",
                        label: "Ladov",
                        core: false,
                    },
                ]}
                entityTypeLabels={{}}
                organization={false}
            />,
        );
    fireEvent.click(screen.getByRole("button", { name: "Merge into…" }));
    await screen.findByRole("option", { name: /Lad/ });
    return screen.getByRole("combobox", { name: "Merge target" });
}

describe.each([
    "person",
    "entity",
    "vocabulary",
] as const)("%s merge target", (mode) => {
    it("focuses search, folds case and accents, keeps duplicates distinct and supports keyboard choice", async () => {
        const search = await open(mode);
        await waitFor(() => expect(document.activeElement).toBe(search));
        const merge = screen.getByRole("button", {
            name: "Merge",
        }) as HTMLButtonElement;
        expect(merge.disabled).toBe(true);
        fireEvent.change(search, { target: { value: "SIMON" } });
        await waitFor(() =>
            expect(screen.getAllByRole("option")).toHaveLength(2),
        );
        const options = screen.getAllByRole("option");
        expect(options[0].textContent).not.toBe(options[1].textContent);
        fireEvent.keyDown(search, { key: "ArrowDown" });
        fireEvent.keyDown(search, { key: "ArrowUp" });
        fireEvent.keyDown(search, { key: "ArrowDown" });
        fireEvent.keyDown(search, { key: "Enter" });
        await waitFor(() => expect(merge.disabled).toBe(false));
        expect(
            screen
                .getByText("Selected")
                .closest('[role="option"]')
                ?.getAttribute("data-value"),
        ).toBe("second");
        fireEvent.click(screen.getAllByRole("option", { name: /Šimon/ })[0]);
        expect(
            screen
                .getByText("Selected")
                .closest('[role="option"]')
                ?.getAttribute("data-value"),
        ).toBe("first");
        fireEvent.change(search, { target: { value: "no-such-candidate" } });
        await screen.findByText("No matches.");
        expect(screen.queryAllByRole("option")).toHaveLength(0);
        expect(merge.disabled).toBe(true);
    });
});

it("searches people by email and shows both scope marks", async () => {
    const search = await open("person");
    expect(screen.getByText("Organization")).toBeTruthy();
    expect(screen.getAllByText("Private")).toHaveLength(2);
    fireEvent.change(search, { target: { value: "SECOND@EXAMPLE.TEST" } });
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    expect(screen.getByRole("option").textContent).toContain(
        "second@example.test",
    );
});
