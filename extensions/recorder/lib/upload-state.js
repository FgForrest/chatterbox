import { STATE } from "./constants.js";

export function canPumpUploads(state) {
    return Boolean(
        state.sessionId &&
            (state.state === STATE.recording ||
                state.state === STATE.finalizing ||
                (state.state === STATE.error && state.stopped)),
    );
}
