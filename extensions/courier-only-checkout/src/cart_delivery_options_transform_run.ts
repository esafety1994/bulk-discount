import type {
  CartDeliveryOptionsTransformRunInput,
  CartDeliveryOptionsTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartDeliveryOptionsTransformRunResult = { operations: [] };

// Case-insensitive match so a stray capitalisation change (e.g. "COURIER")
// doesn't silently break the filter.
const COURIER_TITLE = "courier";

// Rates permitted to appear at checkout alongside Courier. Anything whose
// title does not match one of these patterns is hidden when Courier is
// present. Pattern-based (not exact-string) because Rendr's "Display on
// checkout as" value can be renamed in the Rendr app and may contain
// invisible characters (non-breaking spaces, trailing whitespace) that would
// defeat an exact-string compare. If a new carrier adds a rate that needs to
// coexist with Courier, add a pattern here.
const KEEP_PATTERNS: RegExp[] = [
  /^courier$/i,
  // Rendr same-day / next-day rates — match any title containing "rendr",
  // or any "same day" / "next day" variant (with or without space/hyphen).
  /rendr|same[\s-]?day|next[\s-]?day/i,
];

// Dedicated $0 rate present in every shipping profile. Only B2B-tagged
// customers should ever see it — for everyone else it's hidden.
const B2B_COURIER_TITLE = "b2b courier";

// Starshipit "Plain Label" table rates are for Odoo/staff manual quoting only
// and must never appear at website checkout. Match any title fragment used
// by that configuration so a rate added there can't leak to customers.
const PLAIN_LABEL_PATTERNS = [
  /^plain label/i,
  /^zone \d/i,
  /fixed price/i,
];

function isPlainLabel(title: string | null | undefined): boolean {
  const t = title ?? "";
  return PLAIN_LABEL_PATTERNS.some((p) => p.test(t));
}

export function cartDeliveryOptionsTransformRun(
  input: CartDeliveryOptionsTransformRunInput,
): CartDeliveryOptionsTransformRunResult {
  const operations: CartDeliveryOptionsTransformRunResult["operations"] = [];
  const isB2B = input.cart.buyerIdentity?.customer?.isB2B === true;

  // Multi-warehouse cart = Shopify couldn't fulfill from a single location.
  // For QLD/VIC destinations this means the order routes to Sydney, so
  // customer pickup at their local warehouse isn't actually possible.
  // See ticket 29247 (Checkout Redesign) — hide PICK_UP in that scenario.
  const isMultiWarehouse = input.cart.deliveryGroups.length > 1;

  for (const group of input.cart.deliveryGroups) {
    const options = group.deliveryOptions;

    if (isB2B) {
      // B2B customers should only see the natively-$0 "B2B Courier" rate.
      const b2bCourier = options.find(
        (o) => o.title?.toLowerCase() === B2B_COURIER_TITLE,
      );
      if (b2bCourier) {
        for (const option of options) {
          if (option.handle === b2bCourier.handle) continue;
          operations.push({
            deliveryOptionHide: { deliveryOptionHandle: option.handle },
          });
        }
        operations.push({
          deliveryOptionRename: {
            deliveryOptionHandle: b2bCourier.handle,
            title: "Courier – Freight to be confirmed",
          },
        });
        continue;
      }
      // B2B Courier not configured (e.g. removed from Shipping admin for the
      // GMC free-shipping fix). Fall through to the non-B2B filtering below
      // so Plain Label / Zone / Fixed Price rates stay hidden. The B2B
      // customer will see standard Courier rates until Option B (customer
      // segment + 100% shipping discount) replaces this flow.
    }

    const province = group.deliveryAddress?.provinceCode?.toUpperCase() ?? "";
    const hidePickupForMultiWarehouse =
      isMultiWarehouse && (province === "QLD" || province === "VIC");

    const hasCourier = options.some(
      (o) => o.title?.toLowerCase() === COURIER_TITLE,
    );

    // B2B Courier and Plain Label rates must NEVER be visible to non-B2B
    // customers. If Starshipit fails to return calculated rates for a remote
    // postcode, letting checkout show "no shipping available" is preferable
    // to leaking a $0 or manual-quoting rate. (Real incident: order #49085,
    // Alyangula NT 0885, undercharged shipping by ~$200.)
    const alwaysHide: string[] = [];
    const conditionalHide: string[] = [];

    for (const option of options) {
      const t = option.title?.toLowerCase() ?? "";
      if (t === B2B_COURIER_TITLE || isPlainLabel(option.title)) {
        alwaysHide.push(option.handle);
        continue;
      }
      if (hidePickupForMultiWarehouse && option.deliveryMethodType === "PICK_UP") {
        alwaysHide.push(option.handle);
        continue;
      }
      if (hasCourier && !KEEP_PATTERNS.some((p) => p.test(t))) {
        conditionalHide.push(option.handle);
      }
    }

    for (const handle of alwaysHide) {
      operations.push({ deliveryOptionHide: { deliveryOptionHandle: handle } });
    }

    // Only apply the "keep Courier only" hides if at least one option would
    // remain after both sets are hidden.
    const remaining = options.length - alwaysHide.length - conditionalHide.length;
    if (remaining >= 1) {
      for (const handle of conditionalHide) {
        operations.push({ deliveryOptionHide: { deliveryOptionHandle: handle } });
      }
    }
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
