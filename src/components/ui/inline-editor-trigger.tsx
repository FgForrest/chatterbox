"use client";

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Keep an inline editor's trigger focusable but inactive until the editor closes. */
export function InlineEditorTrigger({
    open,
    onClick,
    className,
    variant = "default",
    ...props
}: ComponentProps<typeof Button> & { open: boolean }) {
    return (
        <Button
            type="button"
            {...props}
            variant={variant}
            aria-disabled={open || Boolean(props.disabled)}
            aria-expanded={open}
            className={cn(
                className,
                "aria-disabled:cursor-default aria-disabled:opacity-50",
                variant === "default"
                    ? "aria-disabled:hover:bg-primary"
                    : variant === "secondary"
                      ? "aria-disabled:hover:bg-secondary"
                      : variant === "destructive"
                        ? "aria-disabled:hover:bg-destructive dark:aria-disabled:hover:bg-destructive/60"
                        : "aria-disabled:hover:bg-transparent dark:aria-disabled:hover:bg-transparent",
            )}
            onClick={(event) => {
                if (!open && !props.disabled) onClick?.(event);
            }}
        />
    );
}
