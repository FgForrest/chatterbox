"use client";

import { Keyboard } from "lucide-react";
import { useExtracted } from "next-intl";
import { Button } from "@/components/ui/button";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ActionTooltip } from "@/components/ui/tooltip";

export function AgendaShortcuts() {
    const i18n = useExtracted();
    return (
        <Popover>
            <ActionTooltip label={i18n("Keyboard shortcuts")}>
                <PopoverTrigger asChild>
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={i18n("Keyboard shortcuts")}
                    >
                        <Keyboard className="size-4" aria-hidden="true" />
                    </Button>
                </PopoverTrigger>
            </ActionTooltip>
            <PopoverContent
                title={i18n("Keyboard shortcuts")}
                className="space-y-1 text-sm"
            >
                <p>{i18n("Enter: new point")}</p>
                <p>{i18n("↑ / ↓ previous / next point")}</p>
                <p>{i18n("Tab: indent · Shift+Tab: outdent")}</p>
                <p>{i18n("Alt+↑/↓: move the point with its sub-points")}</p>
                <p>{i18n("Escape, then Tab: leave editor")}</p>
                <p className="text-xs text-muted-foreground">
                    {i18n(
                        "Up to 3 levels · colleagues’ changes load automatically",
                    )}
                </p>
            </PopoverContent>
        </Popover>
    );
}
