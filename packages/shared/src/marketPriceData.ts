// marketPriceData.ts
//
// Seed price table for tradeInQuote.ts. READ THE CAVEAT BELOW before
// using this in anything real.
//
// ============================================================================
// IMPORTANT — DATA QUALITY CAVEAT
// ============================================================================
// These figures were gathered from general web search (trade-in "value guide"
// sites) in August 2026. That source category is unreliable for this
// purpose: multiple sites quoted DIFFERENT prices for the same exact model/
// storage/condition — e.g. iPhone 14 128GB "Good" condition ranged from
// $159 to $380 depending on the site. That's not normal market variance,
// that's SEO content of inconsistent quality, some of it likely templated/
// auto-generated rather than sourced from real transaction data.
//
// What's in this file is a ROUGH, ILLUSTRATIVE starting point for iPhone 14
// only (where multiple sources at least converged on a plausible range) —
// NOT verified transaction data, and NOT something to price real trade-in
// offers against. Every other model below is extrapolated from typical
// market relationships (Android flagships generally trade 30-45% below
// equivalent-tier iPhones due to faster depreciation), not researched —
// treat those as PLACEHOLDERS to replace, not defaults to ship with.
//
// For production pricing you need one of:
//   - A commercial market-data API (SellCell, Swappa, BankMyCell, or
//     similar buyback-comparison services often expose data feeds/APIs
//     to business partners — contact them directly, don't scrape their
//     public price-guide pages)
//   - Your own historical resale data, once you have transaction volume
//   - A live auction/marketplace price-tracking integration
//
// Prices also decay fast around new model launches (search results
// specifically flagged 20-35% drops tied to iPhone 16 launch timing) —
// whatever feed you use needs to update at least weekly, not be a static
// table like this one.
// ============================================================================

import { MarketPriceEntry } from "./tradeInQuote";

export const SEED_MARKET_PRICES: MarketPriceEntry[] = [
  // iPhone 14 — roughly grounded in multi-source research, still treat as approximate
  { model: "iPhone 14", storageGb: 128, gradeBasePrices: { A: 340, B: 286, C: 220, D: 130 } },
  { model: "iPhone 14", storageGb: 256, gradeBasePrices: { A: 375, B: 315, C: 245, D: 145 } },
  { model: "iPhone 14 Plus", storageGb: 128, gradeBasePrices: { A: 310, B: 265, C: 200, D: 115 } },
  { model: "iPhone 14 Pro", storageGb: 128, gradeBasePrices: { A: 440, B: 378, C: 290, D: 170 } },
  { model: "iPhone 14 Pro Max", storageGb: 256, gradeBasePrices: { A: 560, B: 480, C: 370, D: 220 } },

  // iPhone 13 — NOT researched, extrapolated ~15-20% below iPhone 14 equivalent — PLACEHOLDER
  { model: "iPhone 13", storageGb: 128, gradeBasePrices: { A: 285, B: 240, C: 185, D: 105 } },
  { model: "iPhone 13 Pro", storageGb: 128, gradeBasePrices: { A: 370, B: 315, C: 240, D: 140 } },

  // Samsung Galaxy S24 — NOT researched, extrapolated as ~35-40% below equivalent iPhone
  // tier per typical Android/iOS depreciation gap — PLACEHOLDER, needs real sourcing
  { model: "Galaxy S24", storageGb: 128, gradeBasePrices: { A: 220, B: 185, C: 140, D: 80 } },
  { model: "Galaxy S24 Ultra", storageGb: 256, gradeBasePrices: { A: 360, B: 305, C: 235, D: 135 } },

  // Google Pixel 8 — NOT researched, extrapolated similarly to Galaxy tier — PLACEHOLDER
  { model: "Pixel 8", storageGb: 128, gradeBasePrices: { A: 200, B: 170, C: 130, D: 75 } },
];

// ============================================================================
// APAC MARKET PRICING (USD-denominated)
// ============================================================================
// Separate from the US table above because trade-in economics differ
// materially between markets — India's iPhones hold value unusually
// well due to import-duty-driven scarcity of new units; Australia's
// market has no equivalent dynamic. A blended "APAC average" would
// erase exactly the signal that makes each market usable for real
// pricing.
//
// Same quality caveats as the US table: these are rough snapshots from
// web research, not verified transaction data. Do NOT ship these as
// production pricing — replace with a real per-market feed.
// ============================================================================

export const SEED_MARKET_PRICES_INDIA_USD: MarketPriceEntry[] = [
  // India — converted from ₹ at ~₹83/USD (snapshot, not live FX)
  // iPhone retention percentages are real (68-78% after 2yr for Pro/Pro Max,
  // per Indian market analysis sources). Galaxy S24 Grade A anchored to the
  // one genuinely cited stat: 73.1% depreciation since launch (SellCell Live
  // Depreciation data, March 2026). Everything else is proportional estimate
  // around those anchors.
  { model: "iPhone 14", storageGb: 128, gradeBasePrices: { A: 410, B: 343, C: 253, D: 145 } },
  { model: "iPhone 14 Pro", storageGb: 128, gradeBasePrices: { A: 819, B: 687, C: 518, D: 301 } },
  { model: "iPhone 14 Pro Max", storageGb: 256, gradeBasePrices: { A: 946, B: 795, C: 602, D: 349 } },
  { model: "Galaxy S24", storageGb: 128, gradeBasePrices: { A: 243, B: 205, C: 151, D: 84 } }, // Grade A = real 26.9% retention
  { model: "Galaxy S24 Ultra", storageGb: 256, gradeBasePrices: { A: 572, B: 482, C: 361, D: 211 } },
  { model: "Pixel 8", storageGb: 128, gradeBasePrices: { A: 217, B: 181, C: 133, D: 78 } }, // extrapolated, not researched
];

export const SEED_MARKET_PRICES_AUSTRALIA_USD: MarketPriceEntry[] = [
  // Australia — converted from AUD at ~0.65 AUD→USD (snapshot, not live FX)
  // iPhone 14 Pro Grade B is the one real data point: A$710 buyback in
  // fair/good condition, 59.4% drop from A$1,749 launch (trade.com.au,
  // March 2026). A/C/D are proportional estimates around that anchor.
  // Samsung/Pixel rows are extrapolated from the Australian iPhone
  // depreciation curve (Android loses value faster in Australia too,
  // though not as dramatically as in India) — PLACEHOLDER, needs real
  // Australian buyback sourcing.
  { model: "iPhone 14 Pro", storageGb: 128, gradeBasePrices: { A: 585, B: 462, C: 358, D: 228 } }, // B = real A$710 figure
  { model: "iPhone 14", storageGb: 128, gradeBasePrices: { A: 395, B: 330, C: 250, D: 150 } },
  { model: "Galaxy S24", storageGb: 128, gradeBasePrices: { A: 195, B: 163, C: 122, D: 70 } }, // extrapolated, not researched
  { model: "Galaxy S24 Ultra", storageGb: 256, gradeBasePrices: { A: 340, B: 285, C: 215, D: 125 } }, // extrapolated
];

// New Zealand, Southeast Asia, Japan — NO data found at all. Not included
// rather than invented. These markets need real, per-country sourcing from
// local buyback platforms before any numbers go here.
