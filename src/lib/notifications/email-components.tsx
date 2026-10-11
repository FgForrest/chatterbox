// biome-ignore-all lint/style/noHeadElement: an email's own document, not a Next.js page
import type { ComponentPropsWithoutRef, CSSProperties, ReactNode } from "react";

/*
 * The email building blocks the templates use, ported from react-email
 * (MIT, see NOTICE) so their markup renders the same: tables for layout,
 * inline styles, and Outlook's own spacing for buttons.
 */

type Style = CSSProperties & Record<string, unknown>;

/** The document root; `lang` and `dir` default to `en` and `ltr`. */
export function Html({
    children,
    lang = "en",
    dir = "ltr",
    ...props
}: ComponentPropsWithoutRef<"html">) {
    return (
        <html {...props} dir={dir} lang={lang}>
            {children}
        </html>
    );
}

/** `<head>` with the content type and Apple's no-reformatting hint first. */
export function Head({ children, ...props }: ComponentPropsWithoutRef<"head">) {
    return (
        <head {...props}>
            <meta content="text/html; charset=UTF-8" httpEquiv="Content-Type" />
            <meta name="x-apple-disable-message-reformatting" />
            {children}
        </head>
    );
}

const MARGIN_PROPERTIES = [
    "margin",
    "marginTop",
    "marginBottom",
    "marginRight",
    "marginLeft",
    "marginInline",
    "marginBlock",
    "marginBlockStart",
    "marginBlockEnd",
    "marginInlineStart",
    "marginInlineEnd",
] as const;

/** `<body>` holding a full-width table cell that carries the body's style. */
export function Body({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"body">) {
    const bodyStyle: Style = {
        background: style?.background,
        backgroundColor: style?.backgroundColor,
    };
    if (style) {
        for (const property of MARGIN_PROPERTIES) {
            bodyStyle[property] = style[property] !== undefined ? 0 : undefined;
        }
    }
    return (
        <body {...props} style={bodyStyle}>
            <table
                border={0}
                width="100%"
                cellPadding="0"
                cellSpacing="0"
                role="presentation"
                align="center"
            >
                <tbody>
                    <tr>
                        <td style={style}>{children}</td>
                    </tr>
                </tbody>
            </table>
        </body>
    );
}

const PREVIEW_MAX_LENGTH = 150;
const PREVIEW_WHITESPACE = "\xA0‌​‍‎‏﻿";

/** The inbox preview line: hidden text, padded so the body does not show. */
export function Preview({
    children = "",
    ...props
}: Omit<ComponentPropsWithoutRef<"div">, "children"> & {
    children?: string | string[];
}) {
    const text = (
        Array.isArray(children) ? children.join("") : children
    ).substring(0, PREVIEW_MAX_LENGTH);
    return (
        <div
            style={{
                display: "none",
                overflow: "hidden",
                lineHeight: "1px",
                opacity: 0,
                maxHeight: 0,
                maxWidth: 0,
            }}
            data-skip-in-text={true}
            {...props}
        >
            {text}
            {text.length < PREVIEW_MAX_LENGTH ? (
                <div>
                    {PREVIEW_WHITESPACE.repeat(
                        PREVIEW_MAX_LENGTH - text.length,
                    )}
                </div>
            ) : null}
        </div>
    );
}

/** A centered table at most 37.5em wide. */
export function Container({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"table">) {
    return (
        <table
            align="center"
            width="100%"
            {...props}
            border={0}
            cellPadding="0"
            cellSpacing="0"
            role="presentation"
            style={{ maxWidth: "37.5em", ...style }}
        >
            <tbody>
                <tr style={{ width: "100%" }}>
                    <td>{children}</td>
                </tr>
            </tbody>
        </table>
    );
}

/** A full-width table with one cell. */
export function Section({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"table">) {
    return (
        <table
            align="center"
            width="100%"
            border={0}
            cellPadding="0"
            cellSpacing="0"
            role="presentation"
            {...props}
            style={style}
        >
            <tbody>
                <tr>
                    <td>{children}</td>
                </tr>
            </tbody>
        </table>
    );
}

/** A full-width table row; its children are `Column`s. */
export function Row({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"table">) {
    return (
        <table
            align="center"
            width="100%"
            border={0}
            cellPadding="0"
            cellSpacing="0"
            role="presentation"
            {...props}
            style={style}
        >
            <tbody style={{ width: "100%" }}>
                <tr style={{ width: "100%" }}>{children}</tr>
            </tbody>
        </table>
    );
}

/** A cell of a `Row`. */
export function Column({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"td">) {
    return (
        <td {...props} data-id="__react-email-column" style={style}>
            {children}
        </td>
    );
}

/**
 * An `<h1>`. React-email's `as` (another heading level) and margin
 * shorthands (`m`, `mx`, ...) are not ported, so their props do not type.
 */
export function Heading({
    children,
    style,
    ...props
}: ComponentPropsWithoutRef<"h1">) {
    return (
        <h1 {...props} style={{ ...style }}>
            {children}
        </h1>
    );
}

/** A full-width rule, a light gray line unless styled otherwise. */
export function Hr({ style, ...props }: ComponentPropsWithoutRef<"hr">) {
    return (
        <hr
            {...props}
            style={{
                width: "100%",
                border: "none",
                borderTop: "1px solid #eaeaea",
                ...style,
            }}
        />
    );
}

/** A block image without borders or outlines. */
export function Img({
    alt,
    src,
    width,
    height,
    style,
    ...props
}: ComponentPropsWithoutRef<"img">) {
    return (
        // biome-ignore lint/performance/noImgElement: an email's image, which next/image cannot serve
        <img
            {...props}
            alt={alt}
            height={height}
            src={src}
            style={{
                display: "block",
                outline: "none",
                border: "none",
                textDecoration: "none",
                ...style,
            }}
            width={width}
        />
    );
}

/** A link opening in a new window. */
export function Link({
    target = "_blank",
    style,
    ...props
}: ComponentPropsWithoutRef<"a">) {
    return (
        <a
            {...props}
            style={{ color: "#067df7", textDecorationLine: "none", ...style }}
            target={target}
        >
            {props.children}
        </a>
    );
}

type Margins = {
    marginTop: unknown;
    marginRight?: unknown;
    marginBottom: unknown;
    marginLeft: unknown;
};

function parseMarginValue(value: unknown): Margins {
    if (typeof value === "number") {
        return {
            marginTop: value,
            marginBottom: value,
            marginLeft: value,
            marginRight: value,
        };
    }
    if (typeof value === "string") {
        const values = value.toString().trim().split(/\s+/);
        if (values.length === 1) {
            return {
                marginTop: values[0],
                marginBottom: values[0],
                marginLeft: values[0],
                marginRight: values[0],
            };
        }
        if (values.length === 2) {
            return {
                marginTop: values[0],
                marginRight: values[1],
                marginBottom: values[0],
                marginLeft: values[1],
            };
        }
        if (values.length === 3) {
            return {
                marginTop: values[0],
                marginRight: values[1],
                marginBottom: values[2],
                marginLeft: values[1],
            };
        }
        if (values.length === 4) {
            return {
                marginTop: values[0],
                marginRight: values[1],
                marginBottom: values[2],
                marginLeft: values[3],
            };
        }
    }
    return {
        marginTop: undefined,
        marginBottom: undefined,
        marginLeft: undefined,
        marginRight: undefined,
    };
}

function computeMargins(properties: Record<string, unknown>): Margins {
    let result: Margins = {
        marginTop: undefined,
        marginRight: undefined,
        marginBottom: undefined,
        marginLeft: undefined,
    };
    for (const [key, value] of Object.entries(properties)) {
        if (key === "margin") {
            result = parseMarginValue(value);
        } else if (key === "marginTop") {
            result.marginTop = value;
        } else if (key === "marginRight") {
            result.marginRight = value;
        } else if (key === "marginBottom") {
            result.marginBottom = value;
        } else if (key === "marginLeft") {
            result.marginLeft = value;
        }
    }
    return result;
}

/** A paragraph, 14px on 24px, with 16px above and below unless styled. */
export function Text({ style, ...props }: ComponentPropsWithoutRef<"p">) {
    const defaultMargins: Record<string, string> = {};
    if (style?.marginTop === undefined) defaultMargins.marginTop = "16px";
    if (style?.marginBottom === undefined) defaultMargins.marginBottom = "16px";
    const margins = computeMargins({ ...defaultMargins, ...style });
    return (
        <p
            {...props}
            style={
                {
                    fontSize: "14px",
                    lineHeight: "24px",
                    ...style,
                    ...margins,
                } as CSSProperties
            }
        />
    );
}

function convertToPx(value: unknown): number {
    if (!value) return 0;
    if (typeof value === "number") return value;
    const matches = /^([\d.]+)(px|em|rem|%)$/.exec(String(value));
    if (matches && matches.length === 3) {
        const numValue = Number.parseFloat(matches[1] ?? "");
        switch (matches[2]) {
            case "em":
            case "rem":
                return numValue * 16;
            case "%":
                return (numValue / 100) * 600;
            default:
                return numValue;
        }
    }
    return 0;
}

type Paddings = {
    paddingTop?: unknown;
    paddingRight?: unknown;
    paddingBottom?: unknown;
    paddingLeft?: unknown;
};

function parsePaddingValue(value: unknown): Paddings {
    if (typeof value === "number") {
        return {
            paddingTop: value,
            paddingBottom: value,
            paddingLeft: value,
            paddingRight: value,
        };
    }
    if (typeof value === "string") {
        const values = value.toString().trim().split(/\s+/);
        if (values.length === 1) {
            return {
                paddingTop: values[0],
                paddingBottom: values[0],
                paddingLeft: values[0],
                paddingRight: values[0],
            };
        }
        if (values.length === 2) {
            return {
                paddingTop: values[0],
                paddingRight: values[1],
                paddingBottom: values[0],
                paddingLeft: values[1],
            };
        }
        if (values.length === 3) {
            return {
                paddingTop: values[0],
                paddingRight: values[1],
                paddingBottom: values[2],
                paddingLeft: values[1],
            };
        }
        if (values.length === 4) {
            return {
                paddingTop: values[0],
                paddingRight: values[1],
                paddingBottom: values[2],
                paddingLeft: values[3],
            };
        }
    }
    return {};
}

function parsePadding(properties: Record<string, unknown>) {
    let paddings: Paddings = {};
    for (const [key, value] of Object.entries(properties)) {
        if (key === "padding") {
            paddings = parsePaddingValue(value);
        } else if (
            key === "paddingTop" ||
            key === "paddingRight" ||
            key === "paddingBottom" ||
            key === "paddingLeft"
        ) {
            paddings = { ...paddings, [key]: value };
        }
    }
    return {
        paddingTop: paddings.paddingTop
            ? convertToPx(paddings.paddingTop)
            : undefined,
        paddingRight: paddings.paddingRight
            ? convertToPx(paddings.paddingRight)
            : undefined,
        paddingBottom: paddings.paddingBottom
            ? convertToPx(paddings.paddingBottom)
            : undefined,
        paddingLeft: paddings.paddingLeft
            ? convertToPx(paddings.paddingLeft)
            : undefined,
    };
}

function pxToPt(px: unknown): number | undefined {
    return typeof px === "number" && !Number.isNaN(Number(px))
        ? (px * 3) / 4
        : undefined;
}

const MAX_FONT_WIDTH = 5;

function fontWidthAndSpaceCount(expectedWidth: number): [number, number] {
    if (expectedWidth === 0) return [0, 0];
    let spaceCount = 0;
    const requiredFontWidth = () =>
        spaceCount > 0
            ? expectedWidth / spaceCount / 2
            : Number.POSITIVE_INFINITY;
    while (requiredFontWidth() > MAX_FONT_WIDTH) spaceCount++;
    return [requiredFontWidth(), spaceCount];
}

/**
 * A link styled as a button, opening in a new window. Outlook ignores
 * padding on links, so its horizontal padding is drawn with hair spaces
 * Outlook alone renders, and its vertical padding as a text raise.
 */
export function Button({
    children,
    style,
    target = "_blank",
    ...props
}: ComponentPropsWithoutRef<"a">) {
    const { paddingTop, paddingRight, paddingBottom, paddingLeft } =
        parsePadding((style ?? {}) as Record<string, unknown>);
    const textRaise = pxToPt((paddingTop ?? 0) + (paddingBottom ?? 0));
    const [leftFontWidth, leftSpaceCount] = fontWidthAndSpaceCount(
        paddingLeft ?? 0,
    );
    const [rightFontWidth, rightSpaceCount] = fontWidthAndSpaceCount(
        paddingRight ?? 0,
    );
    return (
        <a
            {...props}
            style={
                {
                    lineHeight: "100%",
                    textDecoration: "none",
                    display: "inline-block",
                    maxWidth: "100%",
                    msoPaddingAlt: "0px",
                    ...style,
                    paddingTop,
                    paddingRight,
                    paddingBottom,
                    paddingLeft,
                } as CSSProperties
            }
            target={target}
        >
            <span
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Outlook-only conditional comment, built from numbers
                dangerouslySetInnerHTML={{
                    __html: `<!--[if mso]><i style="mso-font-width:${leftFontWidth * 100}%;mso-text-raise:${textRaise}" hidden>${"&#8202;".repeat(leftSpaceCount)}</i><![endif]-->`,
                }}
            />
            <span
                style={
                    {
                        maxWidth: "100%",
                        display: "inline-block",
                        lineHeight: "120%",
                        msoPaddingAlt: "0px",
                        msoTextRaise: pxToPt(paddingBottom),
                    } as CSSProperties
                }
            >
                {children as ReactNode}
            </span>
            <span
                // biome-ignore lint/security/noDangerouslySetInnerHtml: Outlook-only conditional comment, built from numbers
                dangerouslySetInnerHTML={{
                    __html: `<!--[if mso]><i style="mso-font-width:${rightFontWidth * 100}%" hidden>${"&#8202;".repeat(rightSpaceCount)}&#8203;</i><![endif]-->`,
                }}
            />
        </a>
    );
}
