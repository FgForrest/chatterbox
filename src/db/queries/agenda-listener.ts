import postgres from "postgres";
import { env } from "@/lib/env";
import { AGENDA_EVENT_CHANNEL } from "@/lib/meetings/event-protocol";

/** Open a dedicated LISTEN connection whose failure is observable by every subscriber. */
export async function openAgendaListener(
    receive: (payload: string) => void,
    failed: () => void,
): Promise<() => void> {
    if (!env.DATABASE_URL) throw new Error("Database unavailable");
    let closed = false;
    const options = {
        max: 1,
        idle_timeout: 0,
        max_lifetime: 0,
        connect_timeout: 5,
        fetch_types: false,
        onnotify: (channel: string, payload: string) => {
            if (!closed && channel === AGENDA_EVENT_CHANNEL) receive(payload);
        },
        onclose: () => {
            if (!closed) {
                close();
                failed();
            }
        },
    };
    const client = postgres(env.DATABASE_URL, options);
    function close() {
        if (closed) return;
        closed = true;
        void client.end({ timeout: 0 }).catch(() => {});
    }
    try {
        await client`LISTEN riffado_agenda`;
        if (closed) throw new Error("Agenda listener closed");
        return close;
    } catch (error) {
        close();
        throw error;
    }
}
