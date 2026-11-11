import { STATE } from "./constants.js";

/** Whether a stopped recording is waiting for upload or server processing. */
export function isWaitingForUpload(state) {
    return state.state === STATE.finalizing || (state.state === STATE.recording && state.stopped);
}

export function canPumpUploads(state) {
    return Boolean(
        state.sessionId &&
            !state.blocked &&
            (state.state === STATE.recording ||
                (state.state === STATE.finalizing && !state.jobId) ||
                (state.state === STATE.error && state.stopped)),
    );
}
