import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("src/app/globals.css", "utf8");
const palette = readFileSync("node_modules/tailwindcss/theme.css", "utf8");
const menu = readFileSync("src/components/ui/dropdown-menu.tsx", "utf8");
type RGB = [number, number, number];

function rgb(source: string, name: string): RGB {
    const value = source.match(
        new RegExp(
            `--${name}:\\s*oklch\\(([\\d.]+)(%)? ([\\d.]+) ([\\d.]+)\\)`,
        ),
    );
    if (!value) throw new Error(`Missing colour: ${name}`);
    const lightness = Number(value[1]) / (value[2] ? 100 : 1);
    const chroma = Number(value[3]);
    const hue = (Number(value[4]) * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);
    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
    return [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map((linear) => {
        const clipped = Math.min(1, Math.max(0, linear));
        return clipped <= 0.0031308
            ? 12.92 * clipped
            : 1.055 * clipped ** (1 / 2.4) - 0.055;
    }) as RGB;
}

function luminance(channels: RGB) {
    return channels.reduce((sum, channel, index) => {
        const linear =
            channel <= 0.04045
                ? channel / 12.92
                : ((channel + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
    }, 0);
}

describe.each(["light", "dark"])("%s destructive menu contrast", (theme) => {
    it.each([
        "hover",
        "focus",
    ])("keeps small text readable on its composited %s surface", (state) => {
        const prefix = `${theme === "dark" ? "dark:" : ""}data-[variant=destructive]:${state}:`;
        const classes = menu.split(/\s+/);
        const foregroundClass = classes.find((value) =>
            value.startsWith(`${prefix}text-red-`),
        );
        expect(foregroundClass).toBeDefined();
        const foreground = rgb(
            palette,
            `color-${foregroundClass?.slice(prefix.length + 5)}`,
        );
        const backgroundClass = classes.find((value) =>
            value.startsWith(`data-[variant=destructive]:${state}:bg-red-`),
        );
        const tint = backgroundClass?.match(/bg-(red-\d+)\/(\d+)/);
        if (!tint) throw new Error("Missing destructive tint");
        const surface = rgb(
            theme === "light"
                ? css.split(".dark {")[0]
                : css.split(".dark {")[1],
            "popover",
        );
        const tintRgb = rgb(palette, `color-${tint[1]}`);
        const alpha = Number(tint[2]) / 100;
        const composite = surface.map(
            (channel, index) => channel * (1 - alpha) + tintRgb[index] * alpha,
        ) as RGB;
        const ink = luminance(foreground);
        const background = luminance(composite);
        const contrast =
            (Math.max(ink, background) + 0.05) /
            (Math.min(ink, background) + 0.05);
        expect(contrast).toBeGreaterThanOrEqual(4.5);
    });
});
