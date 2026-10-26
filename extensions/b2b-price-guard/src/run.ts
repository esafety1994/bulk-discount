// @ts-check
// DIAGNOSTIC VERSION — writes what the Function sees into the cart line title.
// Revert to the production logic once we confirm B2B detection and price
// inputs are correct.
import type {
  RunInput,
  FunctionRunResult,
  CartOperation,
} from "../generated/api";

const NO_CHANGES: FunctionRunResult = {
  operations: [],
};

export function run(input: RunInput): FunctionRunResult {
  const bi = input.cart.buyerIdentity;
  const isAuth = bi?.isAuthenticated ?? false;
  const isCompany = Boolean(bi?.purchasingCompany?.company?.id);
  const hasTag = bi?.customer?.hasAnyTag ?? false;

  const operations: CartOperation[] = [];

  for (const line of input.cart.lines) {
    const price = line.cost?.amountPerQuantity?.amount ?? "null";
    const compare = line.cost?.compareAtAmountPerQuantity?.amount ?? "null";

    const debugTitle = `[DBG auth=${isAuth} comp=${isCompany} tag=${hasTag} p=${price} c=${compare}]`;

    operations.push({
      update: {
        cartLineId: line.id,
        title: debugTitle,
      },
    });
  }

  return operations.length > 0 ? { operations } : NO_CHANGES;
}
