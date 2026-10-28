import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { agendaSuggestions } from "@/db/schema";
import { meetingViewer, requireMeetingAccess } from "./access";
import { bumpAgenda } from "./service";

/** Dismiss open suggestions of one kind under the caller's agenda edit lock. */
export async function dismissSuggestions(
    userId: string,
    id: string,
    kind: "ai" | "carry_over",
) {
    const viewer = await meetingViewer(userId);
    await db.transaction(async (tx) => {
        const { agenda } = await requireMeetingAccess(userId, id, "edit", {
            viewer,
            executor: tx,
            lock: true,
        });
        const changed = await tx
            .update(agendaSuggestions)
            .set({ state: "dismissed", updatedAt: new Date() })
            .where(
                and(
                    eq(agendaSuggestions.agendaId, agenda.id),
                    eq(agendaSuggestions.userId, agenda.userId),
                    eq(agendaSuggestions.kind, kind),
                    eq(agendaSuggestions.state, "open"),
                ),
            )
            .returning({ id: agendaSuggestions.id });
        if (changed.length) await bumpAgenda(tx, agenda);
    });
}
