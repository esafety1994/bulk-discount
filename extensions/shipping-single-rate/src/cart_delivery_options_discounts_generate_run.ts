import {
  DeliveryDiscountSelectionStrategy,
  DiscountClass,
  DeliveryInput,
  CartDeliveryOptionsDiscountsGenerateRunResult,
} from "../generated/api";

// Test-mode gate: when true, the function only applies its discount to
// customers tagged "shipping-test". Flip to false once verified.
const TEST_MODE = false;

const FLAT_RATE_PROVINCES = new Set(["NSW", "VIC", "QLD", "SA", "ACT"]);

const EMPTY: CartDeliveryOptionsDiscountsGenerateRunResult = { operations: [] };

// Shopify flat-rate tiers for General / Bulky Products profiles in the
// NSW/VIC/QLD/SA/ACT zone. Must stay in sync with the shipping settings.
function getFlatRateTier(subtotalDollars: number): number {
  if (subtotalDollars <= 250) return 29;
  if (subtotalDollars < 500) return 39;
  if (subtotalDollars <= 1500) return 89;
  if (subtotalDollars <= 2000) return 129;
  if (subtotalDollars <= 2500) return 150;
  if (subtotalDollars <= 4000) return 240;
  if (subtotalDollars <= 6000) return 360;
  if (subtotalDollars <= 8000) return 480;
  return 600;
}

export function cartDeliveryOptionsDiscountsGenerateRun(
  input: DeliveryInput,
): CartDeliveryOptionsDiscountsGenerateRunResult {
  if (!input.discount.discountClasses.includes(DiscountClass.Shipping)) {
    return EMPTY;
  }

  if (TEST_MODE) {
    const isTester = input.cart.buyerIdentity?.customer?.isShippingTest === true;
    if (!isTester) return EMPTY;
  }

  // B2B shipping is handled by the "B2B Courier" $0 rate + the
  // courier-only-checkout function, not a discount.
  if (input.cart.buyerIdentity?.customer?.isB2B === true) return EMPTY;

  const firstGroup = input.cart.deliveryGroups[0];
  if (!firstGroup) return EMPTY;

  const province = firstGroup.deliveryAddress?.provinceCode ?? "";
  if (!FLAT_RATE_PROVINCES.has(province)) return EMPTY;

  // Detect multi-profile doubling by comparing the delivery option cost
  // against the expected flat-rate tier for the cart subtotal. If actual
  // cost is >= 1.75x expected, Shopify has split shipping across profiles
  // (General + Bulky Products) and charged each separately. Apply 50% to
  // bring it back in line. Cost-based so it doesn't rely on Bulky tags
  // being perfectly synced with profile assignments.
  const subtotal = Number(input.cart.cost?.subtotalAmount?.amount ?? "0");
  const selectedOption = firstGroup.deliveryOptions?.[0];
  const actualCost = Number(selectedOption?.cost?.amount ?? "0");
  if (actualCost <= 0) return EMPTY;

  const expectedTier = getFlatRateTier(subtotal);
  if (actualCost < expectedTier * 1.75) return EMPTY;

  const targets = input.cart.deliveryGroups.map((g) => ({
    deliveryGroup: { id: g.id },
  }));

  return {
    operations: [
      {
        deliveryDiscountsAdd: {
          candidates: [
            {
              message: "",
              targets,
              value: { percentage: { value: 50 as unknown as string } },
            },
          ],
          selectionStrategy: DeliveryDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
