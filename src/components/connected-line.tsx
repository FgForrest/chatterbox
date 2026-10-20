import { CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";

/** A connected or ready state: success color and a circled check, centered unless `align` is `start`. */
export function ConnectedLine({
    children,
    align = "center",
}: {
    children: React.ReactNode;
    align?: "center" | "start";
}) {
    return (
        <p
            className={cn(
                "led-active flex items-center gap-2 text-sm",
                align === "center" && "justify-center",
            )}
        >
            <CircleCheck className="size-4 shrink-0" />
            {children}
        </p>
    );
}
