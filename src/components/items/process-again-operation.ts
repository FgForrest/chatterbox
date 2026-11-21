import {
    type ItemOperation,
    itemOperationResult,
} from "@/components/items/item-operation-queue";
import type { ItemProcessingPresentation } from "@/lib/pipeline/presentation";

/** Request another processing run for the open item. */
export function processAgainOperation(itemId: string): ItemOperation {
    return {
        pendingProcessAgain: true,
        apply: (data) => ({
            ...data,
            processAgain: false,
            processAgainReason: null,
            steps: Object.fromEntries(
                Object.entries(data.steps).map(([phase, step]) => [
                    phase,
                    step.actions.includes("processAgain")
                        ? {
                              ...step,
                              state: "pending",
                              reason: "requested",
                              waitingFor: { kind: "pending" },
                              actions: [],
                          }
                        : step,
                ]),
            ) as ItemProcessingPresentation["steps"],
        }),
        async write() {
            const response = await fetch(
                `/api/recordings/${encodeURIComponent(itemId)}/process-again`,
                { method: "POST" },
            );
            if (!response.ok) throw new Error(String(response.status));
            return itemOperationResult(response);
        },
    };
}
