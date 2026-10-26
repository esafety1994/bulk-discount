import { describe, it, expect } from "vitest";
import { run } from "./run";

// Unit tests exercise the pricing math with a stubbed input shape that
// mirrors the generated `RunInput` type. Input values are POST-CATALOG
// (Shopify has already applied the tier % to both current price and
// compare-at price via the Trade catalog's "Include compare-at price" toggle).

const money = (amount: string, currencyCode = "AUD") => ({
  amount,
  currencyCode,
});

const b2bIdentity = {
  isAuthenticated: true,
  purchasingCompany: { company: { id: "gid://shopify/Company/1" } },
  customer: { id: "gid://shopify/Customer/1", hasAnyTag: true },
};

const d2cIdentity = {
  isAuthenticated: false,
  purchasingCompany: null,
  customer: null,
};

const line = (
  id: string,
  amount: string,
  compareAt: string | null = null,
  quantity = 1
) => ({
  id,
  quantity,
  cost: {
    amountPerQuantity: money(amount),
    compareAtAmountPerQuantity: compareAt ? money(compareAt) : null,
  },
  merchandise: {
    id: "gid://shopify/ProductVariant/1",
    title: "Test variant",
    product: { id: "gid://shopify/Product/1", title: "Test product" },
  },
});

describe("B2B Price Guard", () => {
  it("no-op for D2C customer", () => {
    const result = run({
      cart: {
        buyerIdentity: d2cIdentity,
        lines: [line("line-1", "288.42", "309.72")],
      },
    } as any);
    expect(result).toEqual({ operations: [] });
  });

  it("no-op when B2B product has no compare-at (not on sale)", () => {
    const result = run({
      cart: {
        buyerIdentity: b2bIdentity,
        lines: [line("line-1", "92.00", null)],
      },
    } as any);
    expect(result).toEqual({ operations: [] });
  });

  it("no-op when compare-at equals current price (no sale)", () => {
    const result = run({
      cart: {
        buyerIdentity: b2bIdentity,
        lines: [line("line-1", "92.00", "92.00")],
      },
    } as any);
    expect(result).toEqual({ operations: [] });
  });

  it("Red mat scenario: raises stacked $288.42 to correct $309.72", () => {
    // D2C: compare-at $336.65, sale $313.50.
    // Trade catalog post-adjustment: current $288.42, compare-at $309.72.
    // Rule target = min(tier off compare-at, d2c sale) = min($309.72, $313.50) = $309.72.
    const result = run({
      cart: {
        buyerIdentity: b2bIdentity,
        lines: [line("line-1", "288.42", "309.72")],
      },
    } as any);
    expect(result.operations).toHaveLength(1);
    const op = (result.operations?.[0] as any).update;
    expect(op.cartLineId).toBe("line-1");
    expect(op.price.adjustment.fixedPricePerUnit.amount).toBe("309.72");
  });

  it("deeper D2C sale: tier is beaten by sale, Trade gets sale price", () => {
    // D2C: compare-at $100, deep sale $60 (-40%).
    // Trade catalog post-adjustment: current $55.20 ($60 * 0.92), compare-at $92 ($100 * 0.92).
    // Rule target = min($92, $60) = $60. Function raises $55.20 back to $60.
    const result = run({
      cart: {
        buyerIdentity: b2bIdentity,
        lines: [line("line-1", "55.20", "92.00")],
      },
    } as any);
    expect(result.operations).toHaveLength(1);
    const op = (result.operations?.[0] as any).update;
    expect(op.price.adjustment.fixedPricePerUnit.amount).toBe("60.00");
  });

  it("mixed cart: only touches sale lines, leaves non-sale lines alone", () => {
    const result = run({
      cart: {
        buyerIdentity: b2bIdentity,
        lines: [
          line("line-sale", "288.42", "309.72"),
          line("line-no-sale", "100.00", null),
        ],
      },
    } as any);
    expect(result.operations).toHaveLength(1);
    expect((result.operations?.[0] as any).update.cartLineId).toBe("line-sale");
  });
});
