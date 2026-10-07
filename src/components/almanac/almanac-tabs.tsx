"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useExtracted } from "next-intl";
import { usePendingReviews } from "@/components/learn/review-events";
import { cn } from "@/lib/utils";

type Tab = "people" | "things" | "vocabulary" | "review";

/** Which tab a path belongs to: a person's page is under People. */
function tabOf(pathname: string): Tab {
    if (pathname.startsWith("/almanac/things")) return "things";
    if (pathname.startsWith("/almanac/vocabulary")) return "vocabulary";
    if (pathname.startsWith("/almanac/review")) return "review";
    return "people";
}

/**
 * The Almanac's sections. Review counts what waits for the viewer (Learn's
 * reviews and proposed tasks), as the Almanac's badge in the app nav does.
 */
export function AlmanacTabs() {
    const i18n = useExtracted();
    const pathname = usePathname();
    const pending = usePendingReviews();
    const active = tabOf(pathname);
    const tabs: { key: Tab; href: string; label: string }[] = [
        { key: "people", href: "/almanac", label: i18n("People") },
        { key: "things", href: "/almanac/things", label: i18n("Things") },
        {
            key: "vocabulary",
            href: "/almanac/vocabulary",
            label: i18n("Vocabulary"),
        },
        { key: "review", href: "/almanac/review", label: i18n("Review") },
    ];
    return (
        <nav
            aria-label={i18n("Almanac")}
            className="-mt-2 mb-6 flex gap-1 overflow-x-auto border-b"
        >
            {tabs.map((tab) => (
                <Link
                    key={tab.key}
                    href={tab.href}
                    aria-current={active === tab.key ? "page" : undefined}
                    className={cn(
                        "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                        active === tab.key
                            ? "border-primary text-foreground"
                            : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                >
                    {tab.label}
                    {tab.key === "review" && pending > 0 && (
                        <span className="rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                            {pending}
                        </span>
                    )}
                </Link>
            ))}
        </nav>
    );
}
