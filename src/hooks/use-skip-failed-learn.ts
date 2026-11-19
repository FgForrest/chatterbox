"use client";

import { useExtracted } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { announceLearnReviewsChanged } from "@/components/learn/review-events";
import { getApiErrorMessage } from "@/lib/api-errors";
import { invalidateItemProcessing } from "@/lib/pipeline/item-processing-events";

/** Skip the failed run shown in the Learn widget or workflow strip. */
export function useSkipFailedLearn(itemId: string) {
    const i18n = useExtracted();
    const [skipping, setSkipping] = useState(false);

    const skip = async (runId: string) => {
        setSkipping(true);
        const fallback = i18n("Could not skip Learn");
        try {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(itemId)}/review/skip`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ runId }),
                },
            );
            if (!response.ok) {
                toast.error(await getApiErrorMessage(response, fallback));
                return false;
            }
            toast.success(i18n("Learn review skipped"));
            return true;
        } catch {
            toast.error(fallback);
            return false;
        } finally {
            invalidateItemProcessing(itemId);
            announceLearnReviewsChanged();
            setSkipping(false);
        }
    };

    return { skip, skipping };
}
