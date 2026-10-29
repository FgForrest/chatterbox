import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const tailwind = readFileSync("node_modules/tailwindcss/theme.css", "utf8");
/** OKLab coordinates. */
type Color = [number, number, number];
function color(value: string): Color {
    if (value.startsWith("#")) {
        const [r, g, b] = [1, 3, 5].map((offset) => {
            const channel =
                Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
            return channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
        });
        const l = Math.cbrt(
            0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b,
        );
        const m = Math.cbrt(
            0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b,
        );
        const s = Math.cbrt(
            0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b,
        );
        return [
            0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
        ];
    }
    const values = value.match(/oklch\(([\d.]+)(%)? ([\d.]+) ([\d.]+)\)/);
    if (!values) throw new Error(`Unsupported colour: ${value}`);
    const lightness = Number(values[1]) / (values[2] ? 100 : 1);
    const chroma = Number(values[3]);
    const hue = (Number(values[4]) * Math.PI) / 180;
    return [lightness, chroma * Math.cos(hue), chroma * Math.sin(hue)];
}
function token(source: string, name: string) {
    const value = source.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1];
    if (!value) throw new Error(`Missing token: ${name}`);
    return color(value);
}
function luminance([lightness, a, b]: Color) {
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ]
        .map((channel) => Math.min(1, Math.max(0, channel)))
        .reduce(
            (sum, channel, index) =>
                sum + channel * [0.2126, 0.7152, 0.0722][index],
            0,
        );
}
function distance(one: Color, other: Color) {
    return Math.hypot(one[0] - other[0], one[1] - other[1], one[2] - other[2]);
}
describe.each(["light", "dark"] as const)("%s folder view accents", (theme) => {
    const source =
        theme === "light" ? css.split(".dark {")[0] : css.split(".dark {")[1];
    it.each([
        "tasks",
        "knowledge",
    ])("keeps %s readable and distinct from other semantic colours", (view) => {
        const accent = token(source, view);
        const card = token(source, "card");
        const contrast =
            (Math.max(luminance(accent), luminance(card)) + 0.05) /
            (Math.min(luminance(accent), luminance(card)) + 0.05);
        expect(contrast).toBeGreaterThanOrEqual(4.5);
        const others = [
            "step-review",
            "primary",
            "organization",
            "person-share",
            "series-4",
            view === "tasks" ? "knowledge" : "tasks",
        ].map((name) => token(source, name));
        others.push(
            ...["400", "500", "600"].map((shade) =>
                token(tailwind, `color-violet-${shade}`),
            ),
        );
        for (const other of others)
            expect(distance(accent, other)).toBeGreaterThanOrEqual(0.08);
        expect(css).toContain(`--color-${view}: var(--${view})`);
    });
});
