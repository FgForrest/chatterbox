import { APP_REPOSITORY, APP_VERSION } from "@/lib/version";

export const SUPPORT_EMAIL = "support@riffado.com";

const GITHUB_NEW_ISSUE_URL = `https://github.com/${APP_REPOSITORY}/issues/new`;
const BUG_REPORT_TEMPLATE = "bug_report.yml";

export interface ReportBugOptions {
    errorId?: string;
    errorContext?: string;
    page?: string;
    isHosted?: boolean;
}

export function buildReportBugUrl(opts: ReportBugOptions): string {
    const params = new URLSearchParams({
        template: BUG_REPORT_TEMPLATE,
        version: APP_VERSION,
    });

    const description = buildDescription(opts);
    if (description) {
        params.set("description", description);
    }

    if (opts.isHosted !== undefined) {
        params.set(
            "deployment",
            opts.isHosted ? "Hosted (riffado.com)" : "Self-hosted",
        );
    }

    const additional = buildAdditional(opts);
    if (additional) {
        params.set("additional", additional);
    }

    return `${GITHUB_NEW_ISSUE_URL}?${params.toString()}`;
}

export function buildReportBugMailto(opts: ReportBugOptions): string {
    const subject = opts.errorId
        ? `Riffado bug report (${opts.errorId})`
        : "Riffado bug report";
    const body = [buildDescription(opts), "", "---", buildAdditional(opts)]
        .filter(Boolean)
        .join("\n");

    const qs = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    return `mailto:${SUPPORT_EMAIL}?${qs}`;
}

export function buildReportBugBodyPreview(opts: ReportBugOptions): string {
    const parts = [buildDescription(opts), "", buildAdditional(opts)].filter(
        Boolean,
    );
    return parts.join("\n");
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
