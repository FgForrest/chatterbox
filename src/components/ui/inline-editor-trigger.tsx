"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Keep an inline editor's trigger focusable but inactive until the editor
 * closes. While open it ignores the pointer entirely, so no variant's hover
 * colour or background can make it look clickable.
 */
export function InlineEditorTrigger({
    open,
    onClick,
    className,
    ...props
}: ComponentProps<typeof Button> & { open: boolean }) {
    return (
        <Button
            type="button"
            {...props}
            aria-disabled={open || Boolean(props.disabled)}
            aria-expanded={open}
            className={cn(
                className,
                "aria-disabled:pointer-events-none aria-disabled:opacity-50",
            )}
            onClick={(event) => {
                if (!open && !props.disabled) onClick?.(event);
            }}
        />
    );
}
