import { ChevronDownIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function NativeSelect({
    className,
    children,
    ref,
    ...props
}: React.ComponentProps<"select">) {
    return (
        <span
            data-slot="native-select-wrapper"
            className={cn(
                "relative inline-block h-9 w-fit max-w-full align-middle",
                className,
            )}
        >
            <select
                ref={ref}
                data-slot="native-select"
                className="border-input bg-background text-foreground scheme-light dark:scheme-dark h-full w-full appearance-none rounded-md border px-3 py-2 pr-9 text-sm shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40"
                {...props}
            >
                {children}
            </select>
            <ChevronDownIcon
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 opacity-50"
            />
        </span>
    );
}

export { NativeSelect };
