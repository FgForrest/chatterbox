import type { ContentSegment } from "@/lib/content/types";
import { detectLanguage } from "@/lib/knowledge/stemming/detect-language";

/** Detects the language of the mail's body and quotes, excluding signatures and disclaimers. */
export function detectMailLanguage(
    segments: readonly ContentSegment[],
): string | null {
    return detectLanguage(
        segments
            .filter(
                (segment) =>
                    segment.role === "body" || segment.role === "quoted",
            )
            .map((segment) => segment.text)
            .join("\n"),
    );
}
