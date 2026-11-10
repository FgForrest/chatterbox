import { z } from "zod";
import {
    processRestrictedFolderItem,
    RESTRICTED_FOLDER_JOB_KIND,
} from "@/lib/folders/restricted-folders";
import type { JobHandler } from "@/lib/jobs/types";

const payload = z.object({
    folderId: z.string(),
    itemId: z.string(),
    ownerUserId: z.string(),
    operation: z.enum(["restrict", "lift"]),
    restriction: z.string().datetime(),
});

export const restrictedFolderJobHandler: JobHandler<z.infer<typeof payload>> = {
    kind: RESTRICTED_FOLDER_JOB_KIND,
    concurrency: 2,
    maxAttempts: 5,
    timeoutMs: 120000,
    parsePayload: (raw) => payload.parse(raw),
    async run(context) {
        if (context.userId !== context.payload.ownerUserId)
            throw new Error("INVALID_OWNER");
        await processRestrictedFolderItem(context.payload);
    },
};
