"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { subscribeEvents } from "@/lib/events/client";
import { useRestrictedFolders } from "./restricted-folder-context";

export interface ItemReaders {
    ownerUserId: string;
    restricted: boolean;
    organization: boolean;
    curatorsCanRead: boolean;
    readers: { userId: string; name: string | null; email: string }[];
}

/** Reader identities come exclusively from the server's authorized item projection. */
export function RestrictedItemAudience({ itemId }: { itemId: string }) {
    const i18n = useExtracted();
    const { userId } = useRestrictedFolders();
    const [loaded, setLoaded] = useState<{
        itemId: string;
        userId: string;
        readers: ItemReaders;
    } | null>(null);
    const readers =
        loaded?.itemId === itemId && loaded.userId === userId
            ? loaded.readers
            : null;
    useEffect(() => {
        let abort: AbortController | undefined;
        let generation = 0;
        const load = () => {
            abort?.abort();
            abort = new AbortController();
            const signal = abort.signal;
            const current = ++generation;
            setLoaded(null);
            void fetch(`/api/items/${encodeURIComponent(itemId)}/readers`, {
                signal,
            })
                .then(async (response) => {
                    if (!response.ok) return;
                    const data = (await response.json()) as ItemReaders;
                    if (!signal.aborted && current === generation)
                        setLoaded({ itemId, userId, readers: data });
                })
                .catch(() => {});
        };
        load();
        const unsubscribe = subscribeEvents((event) => {
            if (event.type === "tree" || event.type === "share") load();
        });
        return () => {
            ++generation;
            abort?.abort();
            unsubscribe();
        };
    }, [itemId, userId]);
    if (!readers?.restricted) return null;
    if (readers.organization)
        return (
            <p className="basis-full text-xs text-organization">
                {i18n("Visible to the whole Organization")}
            </p>
        );
    if (
        readers.ownerUserId === userId &&
        readers.readers.every((person) => person.userId === userId)
    )
        return (
            <p className="basis-full text-xs text-muted-foreground">
                {i18n("Visible to the folder's audience and curators")}
            </p>
        );
    return (
        <div className="flex basis-full flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
                <span>{i18n("Visible to")}</span>
                <span className="flex -space-x-1">
                    {readers.readers.map((person) => (
                        <span
                            key={person.userId}
                            title={person.name ?? person.email}
                            role="img"
                            aria-label={person.name ?? person.email}
                            className="flex size-6 items-center justify-center rounded-full border border-background bg-restricted/10 text-restricted"
                        >
                            {(person.name ?? person.email)
                                .split(/\s+/)
                                .map((part) => part[0])
                                .slice(0, 2)
                                .join("")}
                        </span>
                    ))}
                </span>
                {readers.curatorsCanRead && <span>{i18n("and curators")}</span>}
            </div>
            {readers.ownerUserId !== userId && !readers.organization && (
                <p>
                    {i18n(
                        "The Organization Almanac does not learn from this item while its folder is restricted. Speaker names are the owner's.",
                    )}
                </p>
            )}
        </div>
    );
}
