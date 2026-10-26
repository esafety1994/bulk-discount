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
 * Resolves the B2B tier percentage for a given customer tier type + product category.
 *
 * Reads from the shop-level `custom.b2b_tier_map` metafield (JSON), which is the
 * single source of truth for all B2B tier percentages across all customers.
 *
 * Expected metafield shape (percentages as numbers, 8 = 8%):
 * {
 *   "trade": {
 *     "asset_protection": 8,
 *     "safety_flooring": 8,
 *     "traffic_safety": 10,
 *     "default": 8
 *   },
 *   "wholesale": {
 *     "asset_protection": 20,
 *     "traffic_safety": 10,
 *     "default": 20
 *   }
 * }
 *
 * Lookup order:
 *  1. tier_map[tierType][productCategory]  — exact match
 *  2. tier_map[tierType]["default"]        — tier type's default
 *  3. B2B_DEFAULT_TIER_PCT                 — last resort
 *
 * Returns the tier as a decimal (0.08, 0.20) suitable for multiplication.
 */
function resolveTierPct(
  shopMetafieldJson: string | null | undefined,
  tierType: string | null | undefined,
  productCategory: string | null | undefined
): number | null {
  if (!shopMetafieldJson || !tierType) return null;

  let tierMap: Record<string, Record<string, unknown>>;
  try {
    tierMap = JSON.parse(shopMetafieldJson);
  } catch {
    return null;
  }

  const tierBucket = tierMap[tierType];
  if (!tierBucket || typeof tierBucket !== "object") return null;

  const lookupPct = (key: string | null | undefined): number | null => {
    if (!key) return null;
    const raw = tierBucket[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
    // Interpret values > 1 as percentage (e.g. 8 = 8%), values <= 1 as decimal.
    return raw > 1 ? raw / 100 : raw;
  };

  return lookupPct(productCategory) ?? lookupPct("default");
}

/**
 * The main Shopify Function logic
 */
export function run(input: RunInput): FunctionRunResult {
  const buyerIdentity = input.cart.buyerIdentity;
  const shopTierMap = input.shop?.b2bTierMap?.value ?? null;

  const isAuthenticated = buyerIdentity?.isAuthenticated;
  const isB2B = buyerIdentity?.customer?.isB2B ?? false;
  const isB2BCustomer = isAuthenticated && isB2B;

  // Determine the customer's tier type from their tags.
  // Odoo → Shopify sync will tag customers with "Trade Account" or "Wholesale Account".
  const isTrade = buyerIdentity?.customer?.isTrade ?? false;
  const isWholesale = buyerIdentity?.customer?.isWholesale ?? false;
  const tierType = isTrade ? "trade" : isWholesale ? "wholesale" : null;

  const discounts: FunctionRunResult["discounts"] = [];

  for (const line of input.cart.lines) {
    const { merchandise, quantity, id: lineId } = line;

    if (!isProductVariant(merchandise)) continue;

    if (isB2BCustomer) {
      const isAddon = line.isAddon?.value === "true";
      const isFreeFixing = merchandise.product.isFreeFixing;

      if (isAddon && isFreeFixing) {
        discounts.push({
          message: "Free Fixings",
          targets: [
            {
              cartLine: {
                id: lineId,
              },
            } as Target,
          ],
          value: {
            percentage: {
              value: "100.00",
            },
          },
        });
        continue;
      }

      // Trade/Wholesale tier pricing: enforce min(tier_off_compare_at, current_price).
      //
      // Data sources:
      //   - Shop metafield `custom.b2b_tier_map` — single source of truth for all
      //     tier % by tier type + category. Updating one JSON updates all customers.
      //   - Customer tag "Trade Account" or "Wholesale Account" — determines which
      //     bucket in the map to read from.
      //   - Product metafield `custom.b2b_category` — which category to look up.
      //
      // Requires the corresponding B2B catalog price adjustment to be 0% —
      // this Function applies the tier discount instead.
      //
      // See MEMORY: project_b2b_tier_structure.md for the tier table.
      const currentPriceStr = line.cost?.amountPerQuantity?.amount;
      const compareAtStr = line.cost?.compareAtAmountPerQuantity?.amount;

      if (currentPriceStr && tierType) {
        const currentPrice = parseFloat(currentPriceStr);
        const compareAt = compareAtStr ? parseFloat(compareAtStr) : null;

        if (Number.isFinite(currentPrice) && currentPrice > 0) {
          const productCategory =
            merchandise.product.b2bCategory?.value ?? null;
          const tierPct = resolveTierPct(shopTierMap, tierType, productCategory);

          // No tier configured for this customer type + category combo.
          // Products without a matching JSON entry get no discount (matches
          // Satbar's table: Trade has no Site Safety/Traffic/Workplace rows).
          if (tierPct === null) continue;

          // Use variant compare-at as the retail base when available; fall
          // back to currentPrice for non-sale products (where compare_at is
          // null but currentPrice IS the retail since all catalogs are 0%).
          const baseForTier =
            compareAt !== null && Number.isFinite(compareAt)
              ? compareAt
              : currentPrice;
          const tierPrice = baseForTier * (1 - tierPct);
          const targetPrice = Math.min(tierPrice, currentPrice);

          if (targetPrice < currentPrice) {
            const discountPct = ((currentPrice - targetPrice) / currentPrice) * 100;
            discounts.push({
              // Non-breaking space so Shopify renders the discount without a
              // visible label. Shopify falls back to the function name when
              // this is empty/omitted, so a literal space is required.
              message: " ",
              targets: [
                {
                  cartLine: {
                    id: lineId,
                  },
                } as Target,
              ],
              value: {
                percentage: {
                  value: discountPct.toFixed(2),
                },
              },
            });
          }
        }
      }
      continue;
    }

    const metafieldValue = merchandise.product.tieredDiscounts?.value;
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
