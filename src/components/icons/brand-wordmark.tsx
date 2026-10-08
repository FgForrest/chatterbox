import { useLocale } from "next-intl";
import type { HTMLAttributes } from "react";
import { productName } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { WaveformLogo } from "./waveform-logo";

/** Localized product wordmark for navigation and authentication surfaces. */
export function BrandWordmark({
    className,
    ...props
}: HTMLAttributes<HTMLSpanElement>) {
    const name = productName(useLocale());
    return (
        <span
            {...props}
            className={cn(
                "inline-flex items-center gap-2 whitespace-nowrap text-xl font-bold tracking-tight",
                className,
            )}
        >
            <WaveformLogo className="size-[1.1em] shrink-0 text-primary" />
            {name}
        </span>
    );
}
