// @ts-check
import {
  DiscountApplicationStrategy,
  type RunInput,
  type FunctionRunResult,
  type Target,
  type ProductVariant,
} from "../generated/api";

/**
 * Fallback response with no discounts applied
 */
const EMPTY_DISCOUNT: FunctionRunResult = {
  discountApplicationStrategy: DiscountApplicationStrategy.First,
  discounts: [],
};

/**
 * Discount rule structure for tiered quantity discounts
 */
type DiscountRule = {
  min: number | null;
  max: number | null;
  discount: number; // percentage value (e.g., 10 means 10%)
};

/**
 * Type guard to ensure the merchandise is a ProductVariant
 */
function isProductVariant(merchandise: unknown): merchandise is ProductVariant {
  return (
    typeof merchandise === "object" &&
    merchandise !== null &&
    "product" in merchandise
  );
}

/**
 * Parses a metafield string like:
 * "discount|1-4|5%,discount|5-9|10%,discount|10-|15%"
 */
function parseDiscountRules(metafieldValue: string): DiscountRule[] {
  const rules: DiscountRule[] = [];

  const ruleStrings = metafieldValue.split(",");

  for (const ruleStr of ruleStrings) {
    const parts = ruleStr.trim().replace("discount|", "").split("|");

    if (parts.length !== 2) continue;

    const [range, percentageStr] = parts;
    const [minStr, maxStr] = range.replace(/\s+/g, "").split("-");

    const min = minStr ? Number(minStr) : null;
    const max = maxStr ? Number(maxStr) : null;
    const discount = parseFloat(percentageStr.replace("%", ""));

    if (!isNaN(discount)) {
      rules.push({ min, max, discount });
    }
  }

  return rules;
}

/**
 * The main Shopify Function logic
 */
export function run(input: RunInput): FunctionRunResult {
  const buyerIdentity = input.cart.buyerIdentity;

  const isAuthenticated = buyerIdentity?.isAuthenticated;
  const b2bStatus = buyerIdentity?.customer?.metafield?.value;

  // ✅ If the customer is logged in AND has B2B status true → no discount
  if (isAuthenticated && b2bStatus === "true") {
    return EMPTY_DISCOUNT;
  }

  const discounts: FunctionRunResult["discounts"] = [];

  for (const line of input.cart.lines) {
    const { merchandise, quantity, id: lineId } = line;

    if (!isProductVariant(merchandise)) continue;

    const metafieldValue = merchandise.product.metafield?.value;
    if (!metafieldValue) continue;

    const rules = parseDiscountRules(metafieldValue);
    if (rules.length === 0) continue;

    const matchedRule = rules.find(
      (rule) =>
        (rule.min === null || quantity >= rule.min) &&
        (rule.max === null || quantity <= rule.max)
    );

    if (!matchedRule) continue;

    discounts.push({
      targets: [
        {
          cartLine: {
            id: lineId,
          },
        } as Target,
      ],
      value: {
        percentage: {
          value: matchedRule.discount.toFixed(2),
        },
      },
    });
  }

  return discounts.length > 0
    ? {
        discounts,
        discountApplicationStrategy: DiscountApplicationStrategy.All,
      }
    : EMPTY_DISCOUNT;
}
