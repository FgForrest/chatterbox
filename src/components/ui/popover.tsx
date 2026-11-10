"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
    type ComponentProps,
    createContext,
    type RefObject,
    useCallback,
    useContext,
    useLayoutEffect,
    useRef,
    useState,
} from "react";
import { cn } from "@/lib/utils";

const AnchorContext = createContext<RefObject<HTMLButtonElement | null> | null>(
    null,
);

export function Popover(props: ComponentProps<typeof DialogPrimitive.Root>) {
    const anchor = useRef<HTMLButtonElement>(null);
    return (
        <AnchorContext value={anchor}>
            <DialogPrimitive.Root modal={false} {...props} />
        </AnchorContext>
    );
}

export function PopoverTrigger({
    ref,
    ...props
}: ComponentProps<typeof DialogPrimitive.Trigger>) {
    const anchor = useContext(AnchorContext);
    // A wrapping tooltip passes its own ref; both must see the button, or the content opens at the corner.
    const setRef = useCallback(
        (node: HTMLButtonElement | null) => {
            if (anchor) anchor.current = node;
            const cleanup = typeof ref === "function" ? ref(node) : undefined;
            if (ref && typeof ref !== "function") ref.current = node;
            return () => {
                if (anchor) anchor.current = null;
                if (typeof cleanup === "function") cleanup();
                else if (typeof ref === "function") ref(null);
                else if (ref) ref.current = null;
            };
        },
        [anchor, ref],
    );
    return <DialogPrimitive.Trigger ref={setRef} {...props} />;
}

export function PopoverContent({
    className,
    children,
    title,
    ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Content>, "title"> & {
    title: string;
}) {
    const anchor = useContext(AnchorContext);
    const [position, setPosition] = useState({ top: 0, right: 16 });
    useLayoutEffect(() => {
        const place = () => {
            const rect = anchor?.current?.getBoundingClientRect();
            if (rect)
                setPosition({
                    top: rect.bottom + 8,
                    right: Math.max(16, window.innerWidth - rect.right),
                });
        };
        place();
        window.addEventListener("resize", place);
        window.addEventListener("scroll", place, true);
        return () => {
            window.removeEventListener("resize", place);
            window.removeEventListener("scroll", place, true);
        };
    }, [anchor]);
    return (
        <DialogPrimitive.Portal>
            <DialogPrimitive.Content
                aria-describedby={undefined}
                className={cn(
                    "fixed z-50 max-w-[calc(100vw-2rem)] rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg",
                    className,
                )}
                style={position}
                {...props}
            >
                <DialogPrimitive.Title className="sr-only">
                    {title}
                </DialogPrimitive.Title>
                {children}
            </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
    );
}
