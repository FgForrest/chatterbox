"use client";

import { usePathname, useSearchParams } from "next/navigation";
import {
    type ReactNode,
    Suspense,
    useCallback,
    useEffect,
    useRef,
    useState,
} from "react";

const START = 0.08;
const CEILING = 0.994;
const STEP_MS = 200;

/**
 * The thin bar along the top of the window while a clicked link loads its
 * page. It starts when a link to another page is clicked and finishes when
 * the URL changes (or the router pushes a history entry); a link that only
 * changes the query, opens elsewhere, downloads, or is clicked with a
 * modifier key shows nothing.
 */
export function AppProgress({ children }: { children: ReactNode }) {
    return (
        <>
            <Suspense fallback={null}>
                <NavigationProgress />
            </Suspense>
            {children}
        </>
    );
}

function NavigationProgress() {
    const pathname = usePathname();
    const search = useSearchParams().toString();
    const [value, setValue] = useState<number | null>(null);
    const [fading, setFading] = useState(false);
    const running = useRef(false);
    const trickle = useRef<ReturnType<typeof setInterval>>(undefined);
    const fade = useRef<ReturnType<typeof setTimeout>[]>([]);

    const start = useCallback(() => {
        if (running.current) return;
        running.current = true;
        for (const timer of fade.current) clearTimeout(timer);
        fade.current = [];
        setFading(false);
        setValue(START);
        trickle.current = setInterval(
            () => setValue((n) => (n === null ? n : advanced(n))),
            STEP_MS,
        );
    }, []);

    const finish = useCallback(() => {
        if (!running.current) return;
        running.current = false;
        clearInterval(trickle.current);
        setValue(1);
        fade.current = [
            setTimeout(() => setFading(true), STEP_MS),
            setTimeout(() => {
                setValue(null);
                setFading(false);
            }, 2 * STEP_MS),
        ];
    }, []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: the bar finishes whenever the URL changes.
    useEffect(() => {
        finish();
    }, [pathname, search, finish]);

    useEffect(() => {
        const onClick = (event: MouseEvent) => {
            if (opensAnotherPage(event)) start();
        };
        const pushState = window.history.pushState;
        const finishingPushState = new Proxy(pushState, {
            apply(target, thisArg, args: Parameters<History["pushState"]>) {
                finish();
                return Reflect.apply(target, thisArg, args);
            },
        });
        document.addEventListener("click", onClick, true);
        window.history.pushState = finishingPushState;
        return () => {
            document.removeEventListener("click", onClick, true);
            if (window.history.pushState === finishingPushState) {
                window.history.pushState = pushState;
            }
            clearInterval(trickle.current);
            for (const timer of fade.current) clearTimeout(timer);
        };
    }, [start, finish]);

    if (value === null) return null;
    return (
        <div
            aria-hidden
            data-slot="navigation-progress"
            className="pointer-events-none fixed inset-x-0 top-0 z-[99999] h-[3px]"
            style={{
                opacity: fading ? 0 : 1,
                transition: `opacity ${STEP_MS}ms linear`,
            }}
        >
            <div
                className="h-full w-full bg-primary"
                style={{
                    transform: `translate3d(${(value - 1) * 100}%,0,0)`,
                    transition: `transform ${STEP_MS}ms linear`,
                }}
            >
                <div
                    className="absolute right-0 h-full w-[100px]"
                    style={{
                        boxShadow:
                            "0 0 10px var(--color-primary), 0 0 5px var(--color-primary)",
                        transform: "rotate(3deg) translate(0px, -4px)",
                    }}
                />
            </div>
        </div>
    );
}

// Quick at first, slowing as the bar nears its end.
function advanced(n: number): number {
    const amount =
        n < 0.2 ? 0.1 : n < 0.5 ? 0.04 : n < 0.8 ? 0.02 : n < 0.99 ? 0.005 : 0;
    return Math.min(n + amount, CEILING);
}

function opensAnotherPage(event: MouseEvent): boolean {
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return false;
    }
    const anchor =
        event.target instanceof Element ? event.target.closest("a") : null;
    const href = anchor?.getAttribute("href");
    if (!anchor || !href || anchor.hasAttribute("download")) return false;
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return false;
    let url: URL;
    try {
        url = new URL(href, document.baseURI);
    } catch {
        return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return !(
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname
    );
}
