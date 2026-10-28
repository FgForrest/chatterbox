import {
    type ProductNameCase,
    productName,
    UPSTREAM_PRODUCT_NAME,
} from "@/lib/brand";
import { env } from "@/lib/env";

/** Returns the product name for this deployment and locale. */
export function deploymentProductName(
    locale: string,
    grammaticalCase: ProductNameCase = "nominative",
): string {
    return env.IS_HOSTED
        ? UPSTREAM_PRODUCT_NAME
        : productName(locale, grammaticalCase);
}
