"use client";

import { Folder, Users, X } from "lucide-react";
import type { AriaAttributes, RefObject } from "react";
import { cn } from "@/lib/utils";

/** Shared folder chip and optional unfiling action for item headers. */
export function ItemFolderChipBody({
    name,
    organization,
    onSelect,
    onRemove,
    disabled = false,
    removeLabel,
    selectRef,
    title,
    selectDisabled,
    ...ariaProps
}: {
    name: string;
    organization: boolean;
    onSelect: () => void;
    onRemove?: () => void;
    disabled?: boolean;
    removeLabel: string;
    selectRef?: RefObject<HTMLButtonElement | null>;
    title?: string;
    selectDisabled?: boolean;
} & Pick<
    AriaAttributes,
    "aria-label" | "aria-expanded" | "aria-controls" | "aria-haspopup"
>) {
    return (
        <span
            className={cn(
                "inline-flex h-7 items-center overflow-hidden rounded-full border text-xs",
                organization
                    ? "border-organization/20 bg-organization/5"
                    : "border-primary/20 bg-primary/5",
            )}
        >
            <button
                type="button"
                ref={selectRef}
                title={title}
                disabled={selectDisabled}
                {...ariaProps}
                onClick={onSelect}
                className={cn(
                    "inline-flex h-full items-center gap-1.5 px-2.5 text-foreground",
                    organization
                        ? "hover:bg-organization/10"
                        : "hover:bg-primary/10",
                )}
            >
                {organization ? (
                    <Users className="size-3.5 text-organization" />
                ) : (
                    <Folder className="size-3.5 text-primary" />
                )}
                {name}
            </button>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    disabled={disabled}
                    className={cn(
                        "inline-flex h-full items-center border-l px-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50",
                        organization
                            ? "border-organization/15"
                            : "border-primary/15",
                    )}
                    aria-label={removeLabel}
                >
                    <X className="size-3.5" />
                </button>
            )}
        </span>
    );
}
