"use client";

import type { ComponentProps } from "react";
import { Combobox } from "@/components/ui/search-combobox";
import {
    type PeopleListEntry,
    type PeopleListPerson,
    PeopleSearchList,
    type PeopleSearchListProps,
} from "./people-search-list";

/** The shared people list in a searchable field or assignment pill. */
export function PeopleCombobox<T extends PeopleListPerson>({
    list,
    value,
    onValueChange,
    leadingEntries,
    trailingEntries,
    ...popup
}: Omit<ComponentProps<typeof Combobox>, "children"> & {
    list: Omit<
        PeopleSearchListProps<T>,
        | "selection"
        | "leadingEntries"
        | "trailingEntries"
        | "listRef"
        | "onEscape"
        | "onTab"
        | "query"
        | "onQueryChange"
    >;
    value?: string;
    onValueChange: (person: T) => void;
    leadingEntries?: readonly PeopleListEntry[];
    trailingEntries?: readonly PeopleListEntry[];
}) {
    return (
        <Combobox {...popup}>
            {({ query, onQueryChange, close, listRef }) => {
                const withClose = (entries?: readonly PeopleListEntry[]) =>
                    entries?.map((entry) => ({
                        ...entry,
                        onSelect: () => {
                            close();
                            entry.onSelect();
                        },
                    }));
                return (
                    <PeopleSearchList
                        {...list}
                        selection={{
                            id: value,
                            onSelect: (person) => {
                                close();
                                onValueChange(person);
                            },
                        }}
                        leadingEntries={withClose(leadingEntries)}
                        trailingEntries={withClose(trailingEntries)}
                        query={query}
                        onQueryChange={onQueryChange}
                        listRef={listRef}
                        onEscape={close}
                        onTab={close}
                    />
                );
            }}
        </Combobox>
    );
}
