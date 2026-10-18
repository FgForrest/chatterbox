import { productName } from "@/lib/brand";
import { APP_REPOSITORY, APP_VERSION } from "@/lib/version";

export const SUPPORT_EMAIL = "support@riffado.com";

const GITHUB_NEW_ISSUE_URL = `https://github.com/${APP_REPOSITORY}/issues/new`;

export interface ReportBugOptions {
    errorId?: string;
    errorContext?: string;
    page?: string;
    isHosted?: boolean;
    locale?: string;
}

/** A blank GitHub issue with the report as title and body; no issue template. */
export function buildReportBugUrl(opts: ReportBugOptions): string {
    const params = new URLSearchParams({
        title: buildSubject(opts),
        body: buildBody(opts),
    });
    return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}

export function buildReportBugMailto(opts: ReportBugOptions): string {
    const qs = `subject=${encodeURIComponent(buildSubject(opts))}&body=${encodeURIComponent(buildBody(opts))}`;
    const recipient = opts.isHosted ? SUPPORT_EMAIL : "";
    return `mailto:${recipient}?${qs}`;
}

export function buildReportBugBodyPreview(opts: ReportBugOptions): string {
    const parts = [buildDescription(opts), "", buildAdditional(opts)].filter(
        Boolean,
    );
    return parts.join("\n");
}

function buildSubject(opts: ReportBugOptions): string {
    const name = opts.isHosted ? "Riffado" : productName(opts.locale ?? "en");
    return opts.errorId
        ? `${name} bug report (${opts.errorId})`
        : `${name} bug report`;
}

function buildBody(opts: ReportBugOptions): string {
    return [buildDescription(opts), "", "---", buildAdditional(opts)]
        .filter(Boolean)
        .join("\n");
}

function buildDescription(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.errorContext) {
        lines.push(`While trying to: ${opts.errorContext}`);
    }
    if (opts.errorId) {
        if (lines.length > 0) lines.push("");
        lines.push(`Error id: \`${opts.errorId}\``);
    }
    return lines.join("\n");
}

function buildAdditional(opts: ReportBugOptions): string {
    const lines: string[] = [];
    if (opts.page) {
        lines.push(`Page: \`${opts.page}\``);
    }
    lines.push(`Version: ${APP_VERSION}`);
    if (opts.isHosted !== undefined) {
        lines.push(
            `Mode: ${opts.isHosted ? "Hosted (riffado.com)" : "Self-hosted"}`,
        );
    }
    return lines.join("\n");
}
