"use client";

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
}: {
    name: string;
    organization: boolean;
    restricted?: boolean;
    onSelect: () => void;
    onRemove?: () => void;
    disabled?: boolean;
}) {
    const i18n = useExtracted();
    return (
        <ItemFolderChipBody
            name={name}
            organization={organization}
            restricted={restricted}
            onSelect={onSelect}
            onRemove={onRemove}
            disabled={disabled}
            removeLabel={i18n("Remove from {folder}", { folder: name })}
        />
    );
}
