import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PICKER_WINDOW_SIZE } from "../../../extensions/recorder/lib/constants.js";
import { pickerWindowBounds } from "../../../extensions/recorder/lib/picker-window.js";

describe("recorder window for Chrome's sharing dialog", () => {
    it("is large enough for the dialog's list of tabs and screens", () => {
        expect(PICKER_WINDOW_SIZE.width).toBeGreaterThanOrEqual(760);
        expect(PICKER_WINDOW_SIZE.height).toBeGreaterThanOrEqual(600);
    });

    it("opens centered over the browser window in use", () => {
        expect(
            pickerWindowBounds({
                left: 100,
                top: 50,
                width: 1600,
                height: 1000,
            }),
        ).toEqual({
            ...PICKER_WINDOW_SIZE,
            left: 100 + (1600 - PICKER_WINDOW_SIZE.width) / 2,
            top: 50 + (1000 - PICKER_WINDOW_SIZE.height) / 2,
        });
    });

    it("lets Chrome place it when there is no browser window or it is too small", () => {
        for (const anchor of [
            null,
            undefined,
            { width: 1600, height: 1000 },
            { left: 0, top: 0, width: 500, height: 1000 },
            { left: 0, top: 0, width: 1600, height: 400 },
        ]) {
            expect(pickerWindowBounds(anchor)).toEqual(PICKER_WINDOW_SIZE);
        }
    });
});

it("loads the shared bundle and enables fitted growth only after Chrome's source choice", () => {
    const source = readFileSync("extensions/recorder/picker/picker.js", "utf8");
    expect(source).toContain('from "../generated/folders.js"');
    expect(
        source.indexOf('document.body.classList.add("recorder-picker")'),
    ).toBeGreaterThan(source.indexOf("async function fitToRecorder()"));
    expect(
        source.indexOf(
            "await fitToRecorder();",
            source.indexOf("const chosen = await chooseDesktopMedia()"),
        ),
    ).toBeGreaterThan(source.indexOf("if (!chosen)"));
    expect(PICKER_WINDOW_SIZE).toEqual({ width: 800, height: 680 });
});
