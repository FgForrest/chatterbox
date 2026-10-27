import { DELETE as handler34DELETE } from "@/app/api/mail/[id]/route";
import { POST as detachAgenda } from "@/app/api/recordings/[id]/agenda/detach/route";
import { POST as handler3POST } from "@/app/api/recordings/[id]/categorize/preview/route";
import { POST as handler4POST } from "@/app/api/recordings/[id]/categorize/route";
import { DELETE as handler5DELETE } from "@/app/api/recordings/[id]/corrections/[correctionId]/route";
import { POST as handler7POST } from "@/app/api/recordings/[id]/erase/route";
import {
    DELETE as handler8DELETE,
    PATCH as handler8PATCH,
    POST as handler8POST,
} from "@/app/api/recordings/[id]/folders/route";
import { DELETE as handler10DELETE } from "@/app/api/recordings/[id]/intended-placements/[folderId]/route";
import { POST as handler11POST } from "@/app/api/recordings/[id]/intended-placements/confirm/route";
import { PATCH as handler12PATCH } from "@/app/api/recordings/[id]/language/route";
import { POST as handler13POST } from "@/app/api/recordings/[id]/learn/route";
import {
    POST as handler15POST,
    PUT as handler15PUT,
} from "@/app/api/recordings/[id]/peaks/route";
import { POST as handler16POST } from "@/app/api/recordings/[id]/process-again/route";
import { DELETE as handler17DELETE } from "@/app/api/recordings/[id]/review/dismissals/route";
import { POST as handler18POST } from "@/app/api/recordings/[id]/review/finish/route";
import { PATCH as handler19PATCH } from "@/app/api/recordings/[id]/review/items/[itemId]/route";
import {
    DELETE as handler21DELETE,
    PATCH as handler21PATCH,
} from "@/app/api/recordings/[id]/route";
import { PUT as handler22PUT } from "@/app/api/recordings/[id]/speakers/route";
import {
    DELETE as handler23DELETE,
    POST as handler23POST,
} from "@/app/api/recordings/[id]/summary/route";
import { DELETE as handler24DELETE } from "@/app/api/recordings/[id]/tasks/[taskId]/match/route";
import { POST as handler25POST } from "@/app/api/recordings/[id]/tasks/accept/route";
import { POST as handler26POST } from "@/app/api/recordings/[id]/tasks/merge/route";
import { POST as handler27POST } from "@/app/api/recordings/[id]/tasks/route";
import { PATCH as handler28PATCH } from "@/app/api/recordings/[id]/tasks/updates/[updateId]/route";
import { POST as handler29POST } from "@/app/api/recordings/[id]/title/route";
import { POST as handler30POST } from "@/app/api/recordings/[id]/topics/route";
import { POST as handler31POST } from "@/app/api/recordings/[id]/transcribe/route";
import { POST as handler32POST } from "@/app/api/recordings/[id]/transcription/from-browser/route";

export const personWriteRoutes = [
    {
        path: "recordings/[id]/agenda/detach/route.ts",
        method: "POST",
        handler: detachAgenda,
    },
    {
        path: "recordings/[id]/categorize/preview/route.ts",
        method: "POST",
        handler: handler3POST,
    },
    {
        path: "recordings/[id]/categorize/route.ts",
        method: "POST",
        handler: handler4POST,
    },
    {
        path: "recordings/[id]/corrections/[correctionId]/route.ts",
        method: "DELETE",
        handler: handler5DELETE,
    },
    {
        path: "recordings/[id]/erase/route.ts",
        method: "POST",
        handler: handler7POST,
    },
    {
        path: "recordings/[id]/folders/route.ts",
        method: "POST",
        handler: handler8POST,
    },
    {
        path: "recordings/[id]/folders/route.ts",
        method: "PATCH",
        handler: handler8PATCH,
    },
    {
        path: "recordings/[id]/folders/route.ts",
        method: "DELETE",
        handler: handler8DELETE,
    },
    {
        path: "recordings/[id]/intended-placements/[folderId]/route.ts",
        method: "DELETE",
        handler: handler10DELETE,
    },
    {
        path: "recordings/[id]/intended-placements/confirm/route.ts",
        method: "POST",
        handler: handler11POST,
    },
    {
        path: "recordings/[id]/language/route.ts",
        method: "PATCH",
        handler: handler12PATCH,
    },
    {
        path: "recordings/[id]/learn/route.ts",
        method: "POST",
        handler: handler13POST,
    },
    {
        path: "recordings/[id]/peaks/route.ts",
        method: "POST",
        handler: handler15POST,
    },
    {
        path: "recordings/[id]/peaks/route.ts",
        method: "PUT",
        handler: handler15PUT,
    },
    {
        path: "recordings/[id]/process-again/route.ts",
        method: "POST",
        handler: handler16POST,
    },
    {
        path: "recordings/[id]/review/dismissals/route.ts",
        method: "DELETE",
        handler: handler17DELETE,
    },
    {
        path: "recordings/[id]/review/finish/route.ts",
        method: "POST",
        handler: handler18POST,
    },
    {
        path: "recordings/[id]/review/items/[itemId]/route.ts",
        method: "PATCH",
        handler: handler19PATCH,
    },
    {
        path: "recordings/[id]/route.ts",
        method: "PATCH",
        handler: handler21PATCH,
    },
    {
        path: "recordings/[id]/route.ts",
        method: "DELETE",
        handler: handler21DELETE,
    },
    {
        path: "recordings/[id]/speakers/route.ts",
        method: "PUT",
        handler: handler22PUT,
    },
    {
        path: "recordings/[id]/summary/route.ts",
        method: "POST",
        handler: handler23POST,
    },
    {
        path: "recordings/[id]/summary/route.ts",
        method: "DELETE",
        handler: handler23DELETE,
    },
    {
        path: "recordings/[id]/tasks/[taskId]/match/route.ts",
        method: "DELETE",
        handler: handler24DELETE,
    },
    {
        path: "recordings/[id]/tasks/accept/route.ts",
        method: "POST",
        handler: handler25POST,
    },
    {
        path: "recordings/[id]/tasks/merge/route.ts",
        method: "POST",
        handler: handler26POST,
    },
    {
        path: "recordings/[id]/tasks/route.ts",
        method: "POST",
        handler: handler27POST,
    },
    {
        path: "recordings/[id]/tasks/updates/[updateId]/route.ts",
        method: "PATCH",
        handler: handler28PATCH,
    },
    {
        path: "recordings/[id]/title/route.ts",
        method: "POST",
        handler: handler29POST,
    },
    {
        path: "recordings/[id]/topics/route.ts",
        method: "POST",
        handler: handler30POST,
    },
    {
        path: "recordings/[id]/transcribe/route.ts",
        method: "POST",
        handler: handler31POST,
    },
    {
        path: "recordings/[id]/transcription/from-browser/route.ts",
        method: "POST",
        handler: handler32POST,
    },
    { path: "mail/[id]/route.ts", method: "DELETE", handler: handler34DELETE },
] as const;
