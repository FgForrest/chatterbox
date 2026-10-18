import { useLocale } from "next-intl";
import type { HTMLAttributes } from "react";
import { deploymentProductName } from "@/lib/deployment-brand";
import { cn } from "@/lib/utils";
import { WaveformLogo } from "./waveform-logo";

/** Localized product wordmark for navigation and authentication surfaces. */
export function BrandWordmark({
    className,
    ...props
}: HTMLAttributes<HTMLSpanElement>) {
    const name = deploymentProductName(useLocale());
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
