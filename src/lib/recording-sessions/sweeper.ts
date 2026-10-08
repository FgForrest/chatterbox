import { captureServerException } from "@/lib/posthog-server";
import { createStorageProvider } from "@/lib/storage/factory";
import { FAILED_SESSION_RETENTION_MS, OPEN_SESSION_TTL_MS } from "./constants";
import {
    listStaleRecordingSessions,
    markRecordingSessionAborted,
    purgeRecordingSessionChunks,
} from "./store";

// The sessions this sweeps are the exceptions: a tab closed mid-recording
// without a complete call, or a finalize that failed for good. Hourly is
// plenty; the TTLs are measured in hours and days.
const TICK_MS = 60 * 60 * 1000;
const MAX_SESSIONS_PER_TICK = 50;

let started = false;
let running = false;

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const now = Date.now();
        const storage = createStorageProvider();

        // Abandoned open sessions: no `complete` ever arrived. Drop their
        // partial chunks and mark them aborted so they stop counting
        // against anything and leave a visible reason.
        const abandoned = await listStaleRecordingSessions(
            "open",
            new Date(now - OPEN_SESSION_TTL_MS),
            MAX_SESSIONS_PER_TICK,
        );
        for (const session of abandoned) {
            try {
                await purgeRecordingSessionChunks(storage, session.id);
                await markRecordingSessionAborted(
                    session.id,
                    "Abandoned before completion",
                );
            } catch (error) {
                console.error(
                    `[recording-sessions] failed to sweep abandoned session ${session.id}:`,
                    error,
                );
            }
        }

        // Failed sessions past their recovery window: the chunks were kept
        // so support could reassemble them; that window has now closed.
        const failed = await listStaleRecordingSessions(
            "failed",
            new Date(now - FAILED_SESSION_RETENTION_MS),
            MAX_SESSIONS_PER_TICK,
        );
        for (const session of failed) {
            try {
                await purgeRecordingSessionChunks(storage, session.id);
            } catch (error) {
                console.error(
                    `[recording-sessions] failed to purge failed session ${session.id}:`,
                    error,
                );
            }
        }

        const swept = abandoned.length + failed.length;
        if (swept > 0) {
            console.log(
                `[recording-sessions] swept ${abandoned.length} abandoned and ${failed.length} expired-failed session(s)`,
            );
        }
    } catch (error) {
        console.error("[recording-sessions] sweep tick failed:", error);
        captureServerException(error, { source: "recording-sessions-sweeper" });
    } finally {
        running = false;
    }
}

/** Start the abandoned-session sweep. Safe to call more than once. */
export function startRecordingSessionSweeper(): void {
    if (started) return;
    started = true;
    const interval = setInterval(() => {
        void tick();
    }, TICK_MS);
    interval.unref?.();
    void tick();
}

/** Test seam. */
export function __resetRecordingSessionSweeperForTests(): void {
    started = false;
    running = false;
}
