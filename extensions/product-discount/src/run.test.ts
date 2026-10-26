import { describe, it, expect } from 'vitest';
import { run } from './run';
import { DiscountApplicationStrategy } from '../generated/api';

const money = (amount: string, currencyCode = 'AUD') => ({ amount, currencyCode });

const SHOP_TIER_MAP = JSON.stringify({
  trade: {
    asset_protection: 8,
    carpark_protection: 8,
    safety_flooring: 8,
    street_furniture: 8,
    site_safety: 8,
    traffic_safety: 10,
    workplace_safety: 8,
    default: 8,
  },
  wholesale: {
    asset_protection: 20,
    carpark_protection: 20,
    safety_flooring: 20,
    street_furniture: 20,
    site_safety: 8,
    traffic_safety: 10,
    workplace_safety: 8,
    default: 20,
  },
});

const shop = (tierMapJson: string | null = SHOP_TIER_MAP) => ({
  b2bTierMap: tierMapJson ? { value: tierMapJson } : null,
});

const b2bIdentity = (opts: { trade?: boolean; wholesale?: boolean } = {}) => ({
  isAuthenticated: true,
  customer: {
    id: 'gid://shopify/Customer/1',
    isB2B: true,
    isTrade: opts.trade ?? false,
    isWholesale: opts.wholesale ?? false,
  },
});

const d2cIdentity = {
  isAuthenticated: false,
  customer: null,
};

const line = (
  id: string,
  amount: string,
  compareAt: string | null = null,
  opts: {
    isAddon?: boolean;
    isFreeFixing?: boolean;
    tieredDiscounts?: string | null;
    b2bCategory?: string | null;
    quantity?: number;
  } = {}
) => ({
  id,
  quantity: opts.quantity ?? 1,
  isAddon: opts.isAddon ? { value: 'true' } : null,
  cost: {
    amountPerQuantity: money(amount),
    compareAtAmountPerQuantity: compareAt ? money(compareAt) : null,
  },
  merchandise: {
    id: 'gid://shopify/ProductVariant/1',
    title: 'Test variant',
    product: {
      id: 'gid://shopify/Product/1',
      title: 'Test product',
      isFreeFixing: opts.isFreeFixing ?? false,
      tieredDiscounts: opts.tieredDiscounts ? { value: opts.tieredDiscounts } : null,
      b2bCategory: opts.b2bCategory ? { value: opts.b2bCategory } : null,
    },
  },
});

describe('product-discount function', () => {
  it('returns no discounts when no lines match', () => {
    const result = run({
      shop: shop(),
      cart: {
        buyerIdentity: d2cIdentity,
        lines: [line('l1', '100.00', null)],
      },
    } as any);
    expect(result.discounts).toEqual([]);
  });

  describe('B2B tier pricing (shop-metafield + tag driven)', () => {
    it('Trade Account + Safety Flooring: Red mat $313.50 -> $309.72', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '313.50', '336.65', { b2bCategory: 'safety_flooring' })],
        },
      } as any);
      expect(result.discounts).toHaveLength(1);
      expect(result.discounts[0].value.percentage.value).toBe('1.21');
    });

    it('Wholesale Account + Asset Protection: 20% tier off compare-at', () => {
      // Wholesale for asset_protection is 20%. Compare-at $100, sale $93.
      // Tier off compare-at = $80. Target = min($80, $93) = $80. Discount = 13.98%
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ wholesale: true }),
          lines: [line('l1', '93.00', '100.00', { b2bCategory: 'asset_protection' })],
        },
      } as any);
      expect(result.discounts).toHaveLength(1);
      expect(result.discounts[0].value.percentage.value).toBe('13.98');
    });

    it('Traffic Safety category: 10% for both Trade and Wholesale', () => {
      const trade = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '100.00', null, { b2bCategory: 'traffic_safety' })],
        },
      } as any);
      expect(trade.discounts[0].value.percentage.value).toBe('10.00');

      const wholesale = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ wholesale: true }),
          lines: [line('l1', '100.00', null, { b2bCategory: 'traffic_safety' })],
        },
      } as any);
      expect(wholesale.discounts[0].value.percentage.value).toBe('10.00');
    });

    it('Unknown category falls back to tier default', () => {
      // Trade default = 8%
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '100.00', null, { b2bCategory: 'widgets' })],
        },
      } as any);
      expect(result.discounts[0].value.percentage.value).toBe('8.00');
    });

    it('No product category falls back to tier default (Wholesale = 20%)', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ wholesale: true }),
          lines: [line('l1', '100.00', null, { b2bCategory: null })],
        },
      } as any);
      expect(result.discounts[0].value.percentage.value).toBe('20.00');
    });

    it('B2B customer with no Trade/Wholesale tag: no discount applied', () => {
      // Has B2B tag but no tier type tag. Function skips tier logic safely.
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: false, wholesale: false }),
          lines: [line('l1', '100.00', null, { b2bCategory: 'asset_protection' })],
        },
      } as any);
      expect(result.discounts).toEqual([]);
    });

    it('Missing shop metafield falls back to 8% default', () => {
      const result = run({
        shop: shop(null),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '100.00', null, { b2bCategory: 'asset_protection' })],
        },
      } as any);
      expect(result.discounts[0].value.percentage.value).toBe('8.00');
    });

    it('Malformed shop metafield JSON falls back to 8% default', () => {
      const result = run({
        shop: shop('{"trade": broken}'),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '100.00', null)],
        },
      } as any);
      expect(result.discounts[0].value.percentage.value).toBe('8.00');
    });

    it('Deep sale beats tier: no additional discount', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [line('l1', '60.00', '100.00', { b2bCategory: 'asset_protection' })],
        },
      } as any);
      expect(result.discounts).toEqual([]);
    });

    it('Free Fixings addon takes priority over tier logic', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: b2bIdentity({ trade: true }),
          lines: [
            line('l1', '50.00', '100.00', {
              isAddon: true,
              isFreeFixing: true,
              b2bCategory: 'asset_protection',
            }),
          ],
        },
      } as any);
      expect(result.discounts).toHaveLength(1);
      expect(result.discounts[0].message).toBe('Free Fixings');
    });
  });

  describe('D2C quantity-based discounts', () => {
    it('applies tiered discount from metafield when qty matches range', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: d2cIdentity,
          lines: [
            line('l1', '100.00', null, {
              quantity: 6,
              tieredDiscounts: 'discount|1-4|5%,discount|5-9|10%,discount|10-|15%',
            }),
          ],
        },
      } as any);
      expect(result.discounts[0].value.percentage.value).toBe('10.00');
    });

    it('D2C on sale product gets no B2B tier discount', () => {
      const result = run({
        shop: shop(),
        cart: {
          buyerIdentity: d2cIdentity,
          lines: [line('l1', '313.50', '336.65')],
        },
      } as any);
      expect(result.discounts).toEqual([]);
    });
  });
});
