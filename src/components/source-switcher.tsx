"use client";

import { FileText } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ActionTooltip } from "@/components/ui/tooltip";

/** Switches between Plaud, custom, and mixed content sources. */
export function SourceSwitcher({
    ariaLabel,
    sources,
    value,
    onSelect,
    compact = false,
}: {
    compact?: boolean;
    ariaLabel: string;
    sources: readonly string[];
    value: string;
    onSelect: (source: string) => void;
}) {
    const i18n = useExtracted();
    return (
        <>
            {compact && (
                <div className="@min-[560px]/workflow:hidden">
                    <DropdownMenu>
                        <ActionTooltip label={ariaLabel}>
                            <DropdownMenuTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label={ariaLabel}
                                >
                                    <FileText className="size-4" />
                                </Button>
                            </DropdownMenuTrigger>
                        </ActionTooltip>
                        <DropdownMenuContent align="end">
                            <DropdownMenuRadioGroup
                                value={value}
                                onValueChange={onSelect}
                            >
                                {sources.map((source) => (
                                    <DropdownMenuRadioItem
                                        key={source}
                                        value={source}
                                    >
                                        {source === "plaud"
                                            ? "Plaud"
                                            : source === "mixed"
                                              ? i18n("Mix")
                                              : i18n("Custom")}
                                    </DropdownMenuRadioItem>
                                ))}
                            </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
            <fieldset
                className={
                    compact
                        ? "hidden shrink-0 rounded-lg bg-muted/70 p-1 @min-[560px]/workflow:inline-flex"
                        : "inline-flex shrink-0 rounded-lg bg-muted/70 p-1"
                }
                aria-label={ariaLabel}
            >
                {sources.map((source) => (
                    <button
                        key={source}
                        type="button"
                        onClick={() => onSelect(source)}
                        aria-pressed={source === value}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                            source === value
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
                        }`}
                    >
                        {source === "plaud"
                            ? "Plaud"
                            : source === "mixed"
                              ? i18n("Mix")
                              : i18n("Custom")}
                    </button>
                ))}
            </fieldset>
        </>
    );
}
