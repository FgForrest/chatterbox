"use client";

import { type ComponentProps, useCallback } from "react";
import { useAutoGrow } from "@/hooks/use-auto-grow";
import { cn } from "@/lib/utils";

/** A shared textarea with optional content sizing within caller-supplied CSS bounds. */
export function Textarea({
    className,
    autoGrow = false,
    value,
    ref,
    ...props
}: ComponentProps<"textarea"> & { autoGrow?: boolean }) {
    const autoGrowRef = useAutoGrow(String(value ?? ""), autoGrow);
    const mergedRef = useCallback(
        (field: HTMLTextAreaElement | null) => {
            autoGrowRef.current = field;
            const cleanup = typeof ref === "function" ? ref(field) : undefined;
            if (ref && typeof ref !== "function") ref.current = field;
            return () => {
                autoGrowRef.current = null;
                if (typeof cleanup === "function") cleanup();
                else if (typeof ref === "function") ref(null);
                else if (ref) ref.current = null;
            };
        },
        [autoGrowRef, ref],
    );

    return (
        <textarea
            ref={mergedRef}
            data-slot="textarea"
            className={cn(
                "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 rounded-md border bg-background px-3 py-2 text-base leading-6 shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
                "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
                "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
                autoGrow ? "resize-none overflow-y-auto" : "resize-y",
                className,
            )}
            value={value}
            {...props}
        />
    );
}
