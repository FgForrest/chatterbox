// @vitest-environment jsdom

import {
    act,
    cleanup,
    fireEvent,
    render,
    screen,
    within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
    type PeopleListPerson,
    PeopleSearchList,
} from "@/components/people/people-search-list";

const viewer = { id: "viewer", name: "Sára Žulová", self: true };
const contextPerson = { id: "speaker", name: "Vít Zelený" };
const first = { id: "first", name: "Zita Bílová" };
const second = {
    id: "second",
    name: "Jitka Dvořáková",
    email: "work@north.example",
};
const people = [second, contextPerson, viewer, first];

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

function searchField() {
    return screen.getByRole("combobox", { name: "Search people" });
}

function typeQuery(value: string) {
    fireEvent.change(searchField(), { target: { value } });
}

it("puts leading entries first, then the viewer and context, then surnames", () => {
    const onSelect = vi.fn();
    render(
        <PeopleSearchList
            people={people}
            selection={{ id: "none", onSelect: vi.fn() }}
            context={{
                ids: [contextPerson.id, viewer.id],
                heading: "Speakers",
            }}
            leadingEntries={[
                { id: "all", label: "All assignees", onSelect },
                { id: "none", label: "No assignee", onSelect },
            ]}
        />,
    );

    const options = screen.getAllByRole("option");
    expect(options.map((row) => row.getAttribute("data-value"))).toEqual([
        "entry:all",
        "entry:none",
        "person:viewer",
        "person:speaker",
        "person:first",
        "person:second",
    ]);
    expect(
        within(screen.getByRole("group", { name: "Speakers" })).getAllByRole(
            "option",
        ),
    ).toEqual([options[3]]);
    expect(options[1].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(options[0]);
    expect(onSelect).toHaveBeenCalledOnce();
});

it("filters on case- and accent-insensitive word starts in the name or email", () => {
    render(<PeopleSearchList people={people} />);
    for (const query of ["DVOR", "jit dvora", "NORTH", "wor@nor"]) {
        typeQuery(query);
        const options = screen.getAllByRole("option");
        expect(options).toHaveLength(1);
        expect(options[0].textContent).toContain(second.name);
    }
    typeQuery("vorak");
    expect(screen.queryByRole("option")).toBeNull();
});

it.each([
    "Home",
    "End",
])("leaves %s to the search input and still navigates results with arrows", (key) => {
    render(<PeopleSearchList people={[second, first]} />);
    const input = searchField();
    const [initial, next] = screen.getAllByRole("option");
    expect(fireEvent.keyDown(input, { key })).toBe(true);
    expect(input.getAttribute("aria-activedescendant")).toBe(initial.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(next.id);
});

it("excludes people even when pinned and offers creation with the trimmed query", () => {
    const onCreate = vi.fn();
    render(
        <PeopleSearchList
            people={people}
            pinnedIds={[first.id, second.id]}
            excludedIds={[second.id]}
            create={{ label: (name) => `Create ${name}`, onSelect: onCreate }}
        />,
    );
    expect(screen.getAllByRole("option")[0].textContent).toContain(first.name);
    expect(screen.queryByText(second.name)).toBeNull();
    typeQuery("  Eda Sýkora  ");
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith("Eda Sýkora");
});

it("checks multiple selections and toggles them with the keyboard", () => {
    function Picker() {
        const [ids, setIds] = useState([first.id]);
        return (
            <PeopleSearchList
                people={[first, second]}
                selection={{
                    ids,
                    onToggle: ({ id }) =>
                        setIds(
                            ids.includes(id)
                                ? ids.filter((selected) => selected !== id)
                                : [...ids, id],
                        ),
                }}
            />
        );
    }
    render(<Picker />);
    const options = screen.getAllByRole("option");
    expect(options.map((row) => row.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
    ]);
    fireEvent.keyDown(searchField(), { key: "ArrowDown" });
    expect(searchField().getAttribute("aria-activedescendant")).toBe(
        options[1].id,
    );
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(options.map((row) => row.getAttribute("aria-checked"))).toEqual([
        "true",
        "true",
    ]);
    fireEvent.keyDown(searchField(), { key: "Enter" });
    expect(options[1].getAttribute("aria-checked")).toBe("false");
});

it("keeps the active option linked when new data moves it out of a context group", () => {
    const context = { ids: [contextPerson.id], heading: "Speakers" };
    const view = render(
        <PeopleSearchList people={[contextPerson, first]} context={context} />,
    );
    expect(searchField().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("option", { name: contextPerson.name }).id,
    );
    view.rerender(
        <PeopleSearchList
            people={[{ ...contextPerson, self: true }, first]}
            context={context}
        />,
    );
    expect(searchField().getAttribute("aria-activedescendant")).toBe(
        screen.getByRole("option", { name: `${contextPerson.name} You` }).id,
    );
});

it("marks only the pinned viewer as You", () => {
    render(<PeopleSearchList people={people} />);
    expect(
        screen.getByRole("option", { name: `${viewer.name} You` }),
    ).toBeTruthy();
    expect(screen.getAllByText("You")).toHaveLength(1);
});

it("debounces server search and ignores responses to older queries", async () => {
    vi.useFakeTimers();
    const older = Promise.withResolvers<PeopleListPerson[]>();
    const newer = Promise.withResolvers<PeopleListPerson[]>();
    const load = vi
        .fn<
            (query: string, signal: AbortSignal) => Promise<PeopleListPerson[]>
        >()
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise);
    render(<PeopleSearchList search={{ load, onError: vi.fn() }} />);

    typeQuery("j");
    act(() => vi.advanceTimersByTime(300));
    expect(load).not.toHaveBeenCalled();
    typeQuery("jit");
    act(() => vi.advanceTimersByTime(249));
    expect(load).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(load.mock.calls[0]?.[0]).toBe("jit");

    typeQuery("jitk");
    expect(load.mock.calls[0]?.[1].aborted).toBe(true);
    act(() => vi.advanceTimersByTime(250));
    expect(load.mock.calls[1]?.[0]).toBe("jitk");
    await act(async () => newer.resolve([second]));
    expect(screen.getByText(second.name)).toBeTruthy();
    await act(async () => older.resolve([{ id: "old", name: "Jitka Šedá" }]));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByText(second.name)).toBeTruthy();
});
