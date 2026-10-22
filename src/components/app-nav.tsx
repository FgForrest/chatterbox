"use client";

import { BookOpenText, ListChecks, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useExtracted, useLocale } from "next-intl";
import { useCallback, useEffect, useRef } from "react";
import { WaveformLogo } from "@/components/icons/waveform-logo";
import { usePendingReviews } from "@/components/learn/review-events";
import { useProductName } from "@/components/product-name-provider";
import { usePendingTasks } from "@/components/tasks/use-pending-tasks";
import { cn } from "@/lib/utils";

/**
 * The app's top-level sections.
 *
 * Riffado had exactly one view until the knowledge base arrived, so this is
 * the first navigation it has ever had. Deliberately plain links rather
 * than a shell rewrite: the header already carries the page identity, and a
 * sidebar for three destinations would be furniture.
 */
export function AppNav({ className }: { className?: string }) {
    const i18n = useExtracted();
    const locale = useLocale();
    const name = useProductName();
    const pathname = usePathname();
    const router = useRouter();
    const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pressed = useRef(false);
    const pressStart = useRef<{ x: number; y: number } | null>(null);
    const cancelLongPress = useCallback(() => {
        if (longPress.current) clearTimeout(longPress.current);
        longPress.current = null;
        pressStart.current = null;
    }, []);
    useEffect(() => cancelLongPress, [cancelLongPress]);
    const openAdd = () => router.push(`/tasks?add=${Date.now()}`);
    // Learn reviews waiting for the viewer: a badge on the Almanac, which
    // lists them. Nothing shows where Learn is unavailable (the count is 0).
    const pendingReviews = usePendingReviews();
    // Tasks assigned to the viewer since they last looked.
    const pendingTasks = usePendingTasks();
    const sections = [
        { href: "/dashboard", label: i18n("Chatter"), icon: MessagesSquare },
        { href: "/almanac", label: i18n("Almanac"), icon: BookOpenText },
        { href: "/tasks", label: i18n("Tasks"), icon: ListChecks },
    ] as const;

    return (
        <div
            className={cn(
                "flex min-w-0 items-center gap-3 xl:gap-6",
                className,
            )}
        >
            <Link
                href="/dashboard"
                aria-label={`${name} ${locale === "cs-CZ" ? "domů" : "home"}`}
                className="hidden shrink-0 text-primary transition-opacity hover:opacity-80 md:block"
            >
                <WaveformLogo className="h-10 w-9" />
            </Link>
            <nav
                aria-label={i18n("Sections")}
                className="flex h-11 min-w-0 items-stretch overflow-hidden rounded-xl border border-border/90 bg-card/30 shadow-sm sm:h-[54px]"
            >
                {sections.map((section) => {
                    const active = pathname.startsWith(section.href);
                    const Icon = section.icon;
                    const addsTask = section.href === "/tasks";
                    return (
                        <Link
                            key={section.href}
                            href={section.href}
                            title={
                                addsTask
                                    ? i18n(
                                          "Right-click or long press to add an own task",
                                      )
                                    : undefined
                            }
                            onContextMenu={(event) => {
                                if (!addsTask) return;
                                event.preventDefault();
                                cancelLongPress();
                                if (!pressed.current) openAdd();
                            }}
                            onKeyDown={(event) => {
                                if (
                                    addsTask &&
                                    (event.key === "ContextMenu" ||
                                        (event.shiftKey && event.key === "F10"))
                                ) {
                                    event.preventDefault();
                                    openAdd();
                                }
                            }}
                            onPointerDown={(event) => {
                                if (!addsTask || event.pointerType !== "touch")
                                    return;
                                cancelLongPress();
                                pressed.current = false;
                                pressStart.current = {
                                    x: event.clientX,
                                    y: event.clientY,
                                };
                                longPress.current = setTimeout(() => {
                                    pressed.current = true;
                                    openAdd();
                                }, 550);
                            }}
                            onPointerMove={(event) => {
                                const start = pressStart.current;
                                if (
                                    start &&
                                    Math.hypot(
                                        event.clientX - start.x,
                                        event.clientY - start.y,
                                    ) > 10
                                )
                                    cancelLongPress();
                            }}
                            onPointerUp={cancelLongPress}
                            onPointerCancel={cancelLongPress}
                            onClick={(event) => {
                                if (addsTask && pressed.current) {
                                    event.preventDefault();
                                    pressed.current = false;
                                }
                            }}
                            aria-current={active ? "page" : undefined}
                            aria-label={
                                section.href === "/tasks" && pendingTasks > 0
                                    ? `${section.label}, ${i18n(
                                          "{count, plural, one {# new task or proposal for you} other {# new tasks or proposals for you}}",
                                          { count: pendingTasks },
                                      )}`
                                    : section.href === "/almanac" &&
                                        pendingReviews > 0
                                      ? `${section.label}, ${i18n(
                                            "{count, plural, one {# review waits} other {# reviews wait}}",
                                            { count: pendingReviews },
                                        )}`
                                      : section.label
                            }
                            className={cn(
                                "relative flex min-w-9 items-center justify-center gap-1.5 px-2 text-sm font-semibold tracking-tight transition-[color,background-color] focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-2 sm:px-3 sm:text-base xl:gap-3 xl:px-9 xl:text-lg",
                                active
                                    ? "bg-primary/[0.12] text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary"
                                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                            )}
                        >
                            <Icon
                                className={cn(
                                    "size-[18px] shrink-0 sm:size-5",
                                    active && "text-primary",
                                )}
                                strokeWidth={1.9}
                                aria-hidden="true"
                            />
                            <span
                                className={
                                    active ? "inline" : "hidden sm:inline"
                                }
                            >
                                {section.label}
                            </span>
                            {section.href === "/almanac" &&
                                pendingReviews > 0 && (
                                    <span
                                        className="absolute right-0.5 top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-[9px] font-semibold leading-3 text-primary-foreground sm:static sm:px-1.5 sm:text-xs sm:leading-normal"
                                        aria-hidden="true"
                                        title={i18n(
                                            "{count, plural, one {# review waits} other {# reviews wait}}",
                                            { count: pendingReviews },
                                        )}
                                    >
                                        {pendingReviews}
                                    </span>
                                )}
                            {section.href === "/tasks" && pendingTasks > 0 && (
                                <span
                                    className="absolute right-0.5 top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-[9px] font-semibold leading-3 text-primary-foreground sm:static sm:px-1.5 sm:text-xs sm:leading-normal"
                                    aria-hidden="true"
                                    title={i18n(
                                        "{count, plural, one {# new task or proposal for you} other {# new tasks or proposals for you}}",
                                        { count: pendingTasks },
                                    )}
                                >
                                    {pendingTasks}
                                </span>
                            )}
                        </Link>
                    );
                })}
            </nav>
        </div>
    );
}
