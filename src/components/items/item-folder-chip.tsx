"use client";

import { Loader2 } from "lucide-react";
import { useExtracted } from "next-intl";
import { ItemFolderChipBody } from "@/components/items/item-folder-chip-body";

/** Shared folder chip and optional unfiling action for item headers. */
export function ItemFolderChip({
    name,
    organization,
    restricted,
    onSelect,
    onRemove,
    disabled = false,
    pending = false,
}: {
    name: string;
    organization: boolean;
    restricted?: boolean;
    onSelect: () => void;
    onRemove?: () => void;
    disabled?: boolean;
    pending?: boolean;
}) {
    const i18n = useExtracted();
    return (
        <ItemFolderChipBody
            name={name}
            organization={organization}
            restricted={restricted}
            onSelect={onSelect}
            onRemove={onRemove}
            disabled={disabled || pending}
            selectDisabled={pending}
            saving={pending ? <ItemFolderSaving /> : undefined}
            removeLabel={i18n("Remove from {folder}", { folder: name })}
        />
    );
}

/** Announce an item folder write and indicate that it is still in progress. */
export function ItemFolderSaving() {
    const i18n = useExtracted();
    return (
        <output className="inline-flex items-center px-1.5">
            <Loader2
                className="size-3 animate-spin motion-reduce:animate-none"
                aria-hidden
            />
            <span className="sr-only">
                {i18n({ id: "itemFolderSaving", message: "Saving…" })}
            </span>
        </output>
    );
}
