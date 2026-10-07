"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { CircleHelp, ExternalLink, XIcon } from "lucide-react";
import { useExtracted } from "next-intl";
import { useRef, useState } from "react";
import { type HelpTarget, helpUrl } from "@/lib/help/topics";

interface HelpDrawerProps {
    /** What to show; null keeps the drawer closed. */
    target: HelpTarget | null;
    onClose: () => void;
}

interface Shown {
    title: string | null;
    fullGuideUrl: string;
    failed: boolean;
}

/**
 * The user guide in a panel beside the app. The chapter renders in a frame
 * of the chrome-less `/help` route, so it is the same page `/docs` shows,
 * without its navigation and without its styles reaching the app.
 */
export function HelpDrawer({ target, onClose }: HelpDrawerProps) {
    const i18n = useExtracted();
    const frame = useRef<HTMLIFrameElement>(null);
    const src = target ? helpUrl(target, "/help") : null;
    const [shown, setShown] = useState<Shown | null>(null);

    const targetGuideUrl = target ? helpUrl(target, "/docs") : "/docs";
    const fullGuideUrl = shown?.fullGuideUrl ?? targetGuideUrl;

    const readFrame = () => {
        const win = frame.current?.contentWindow;
        const root = win?.document.querySelector("[data-help-page]");
        if (!win || !root) {
            setShown({
                title: null,
                failed: true,
                fullGuideUrl: targetGuideUrl,
            });
            return;
        }
        const update = () =>
            setShown({
                title: root.getAttribute("data-help-title"),
                failed: false,
                fullGuideUrl:
                    win.location.pathname.replace(/^\/help/, "/docs") +
                    win.location.hash,
            });
        update();
        win.addEventListener("hashchange", update);
    };

    return (
        <DialogPrimitive.Root
            open={target !== null}
            onOpenChange={(open) => {
                if (!open) {
                    setShown(null);
                    onClose();
                }
            }}
        >
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-[60] bg-black/20" />
                <DialogPrimitive.Content className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-[60] flex w-full flex-col border-l bg-background shadow-xl duration-200 sm:w-[560px]">
                    <div className="flex items-center gap-3 border-b px-4 py-3">
                        <CircleHelp
                            className="size-4 shrink-0 text-muted-foreground"
                            aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                            <DialogPrimitive.Title className="truncate text-sm font-semibold">
                                {shown?.title ?? i18n("Help")}
                            </DialogPrimitive.Title>
                            <DialogPrimitive.Description className="text-xs text-muted-foreground">
                                {i18n("User guide")}
                            </DialogPrimitive.Description>
                        </div>
                        <a
                            href={fullGuideUrl}
                            target="_blank"
                            rel="noopener"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-primary hover:bg-primary/10"
                        >
                            {i18n("Open full guide")}
                            <ExternalLink
                                className="size-3.5"
                                aria-hidden="true"
                            />
                        </a>
                        <DialogPrimitive.Close
                            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={i18n("Close help")}
                        >
                            <XIcon className="size-4" />
                        </DialogPrimitive.Close>
                    </div>
                    {shown?.failed ? (
                        <p className="p-6 text-sm text-muted-foreground">
                            {i18n(
                                "This page of the guide could not be loaded. Open the full guide instead.",
                            )}
                        </p>
                    ) : null}
                    {src ? (
                        <iframe
                            key={src}
                            ref={frame}
                            src={src}
                            title={i18n("User guide")}
                            onLoad={readFrame}
                            className={
                                shown?.failed ? "hidden" : "w-full flex-1"
                            }
                        />
                    ) : null}
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
