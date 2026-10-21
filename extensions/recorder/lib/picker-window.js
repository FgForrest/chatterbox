import { PICKER_WINDOW_SIZE } from "./constants.js";

/**
 * Where to open the recorder window that hosts Chrome's sharing dialog:
 * centered over the browser window the person was using, when that window
 * is large enough to hold it; otherwise wherever Chrome places it.
 */
export function pickerWindowBounds(anchor) {
    const { width, height } = PICKER_WINDOW_SIZE;
    if (
        !Number.isFinite(anchor?.left) ||
        !Number.isFinite(anchor?.top) ||
        !(anchor?.width >= width) ||
        !(anchor?.height >= height)
    ) {
        return { width, height };
    }
    return {
        width,
        height,
        left: anchor.left + Math.round((anchor.width - width) / 2),
        top: anchor.top + Math.round((anchor.height - height) / 2),
    };
}
