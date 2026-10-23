"use client";

import { useExtracted } from "next-intl";
import { useEffect, useState } from "react";
import { ShareAdditionsGroupCard } from "@/components/almanac/share-additions-list";
import { Button } from "@/components/ui/button";
import type {
    SharedAdditionsGroup,
    SharedAdditionsPage,
} from "@/lib/knowledge/share-review";

export function FolderShareFix({
    eventId,
    onChanged,
}: {
    eventId: string;
    onChanged: () => void;
}) {
    const i18n = useExtracted();
    const [group, setGroup] = useState<SharedAdditionsGroup | null>(null);
    const [error, setError] = useState(false);
    const [retry, setRetry] = useState(0);
    useEffect(() => {
        const controller = new AbortController();
        setError(false);
        void fetch(
            `/api/knowledge/care/shares?eventId=${encodeURIComponent(eventId)}&retry=${retry}`,
            { signal: controller.signal },
        )
            .then(async (response) => {
                if (!response.ok) throw new Error();
                const page: SharedAdditionsPage = await response.json();
                if (!controller.signal.aborted)
                    setGroup(page.groups[0] ?? null);
            })
            .catch(() => {
                if (!controller.signal.aborted) setError(true);
            });
        return () => controller.abort();
    }, [eventId, retry]);
    return error ? (
        <div role="alert">
            {i18n("Could not load Care")}
            <Button
                variant="outline"
                onClick={() => setRetry((value) => value + 1)}
            >
                {i18n("Try again")}
            </Button>
        </div>
    ) : group ? (
        <ShareAdditionsGroupCard group={group} onChanged={onChanged} />
    ) : (
        <output>{i18n("Loading…")}</output>
    );
}
