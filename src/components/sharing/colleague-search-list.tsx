"use client";

import { useExtracted } from "next-intl";
import { useCallback } from "react";
import {
    PeopleSearchList,
    type PeopleSearchListProps,
} from "@/components/people/people-search-list";
import { getApiErrorMessage } from "@/lib/api-errors";

export interface AudiencePerson {
    id: string;
    name: string | null;
    email: string;
}

/** Search eligible colleagues for invitations and restricted audiences. */
export function ColleagueSearchList({
    enabled = true,
    onError,
    ...props
}: Omit<
    PeopleSearchListProps<AudiencePerson>,
    "people" | "search" | "label"
> & {
    enabled?: boolean;
    onError: (error: unknown) => void;
}) {
    const i18n = useExtracted();
    const fallback = i18n("Could not find colleagues");
    const load = useCallback(
        async (query: string, signal: AbortSignal) => {
            const response = await fetch(
                `/api/shares/people?q=${encodeURIComponent(query)}`,
                { signal },
            );
            if (!response.ok)
                throw new Error(await getApiErrorMessage(response, fallback));
            const data = (await response.json()) as {
                people: AudiencePerson[];
            };
            return data.people;
        },
        [fallback],
    );
    return (
        <PeopleSearchList
            {...props}
            label={i18n("Colleague's name or email")}
            autoFocus={false}
            disabled={props.disabled || !enabled}
            pinnedIds={[]}
            framed
            search={enabled ? { load, onError } : undefined}
        />
    );
}
