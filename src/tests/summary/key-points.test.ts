import { describe, expect, it } from "vitest";
import { parseKeyPoints } from "@/lib/summary/key-points";

describe("parseKeyPoints", () => {
    it.each([
        { text: "- One\n* Two\n• Three", expected: ["One", "Two", "Three"] },
        { text: "One\nTwo", expected: ["One", "Two"] },
        { text: "- One\n\n- Two", expected: ["One", "Two"] },
        { text: "\n \n-\n*\n•\n- \n* \n• ", expected: [] },
        { text: "", expected: [] },
        { text: "- - x\n- * y\n* • z", expected: ["- x", "* y", "• z"] },
        { text: "- One\r\n\r\n• Two\r\n", expected: ["One", "Two"] },
        {
            text: " \t-  One \t\n\t* Two\t \n  Three  ",
            expected: ["One", "Two", "Three"],
        },
        {
            text: "-word\n*word\n•word\nPoint - detail",
            expected: ["-word", "*word", "•word", "Point - detail"],
        },
    ])("parses $text", ({ text, expected }) => {
        expect(parseKeyPoints(text)).toEqual(expected);
    });
});
