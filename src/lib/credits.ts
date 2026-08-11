// ─── Discord credit packs (consumable SKUs) ──────────────────────
// Maps published Discord SKU IDs → the image credits each grants, plus the
// metadata for the buy buttons. When a user buys a pack, Discord creates an
// entitlement for that SKU; we look it up here, grant the credits, then consume
// the entitlement. Credits are only meaningful on Discord (metered) tenants.

export interface CreditPack {
    skuId: string;
    credits: number;
    label: string;
    price: string;
}

// The three consumable SKUs, published in the Discord dev portal (Store & API).
// Sizes are deliberately a SHALLOW volume discount ($0.374 -> $0.325/credit).
// Steep discounts assume near-zero marginal cost; ours is ~$0.10/render, so the
// biggest pack would otherwise be the worst-margin thing we sell.
export const CREDIT_PACKS: CreditPack[] = [
    { skuId: '1534637348984324217', credits: 8, label: '8 credits', price: '$2.99' },
    { skuId: '1534638301963747458', credits: 20, label: '20 credits', price: '$6.99' },
    { skuId: '1534638455060041888', credits: 40, label: '40 credits', price: '$12.99' },
];

/** Image credits granted by a purchased SKU, or 0 if it is not a known pack. */
export function creditsForSku(skuId: string): number {
    return CREDIT_PACKS.find((p) => p.skuId === skuId)?.credits ?? 0;
}

// Discord PREMIUM buttons (component type 2, style 6): each carries a sku_id and
// no label/custom_id — Discord renders the pack name + price and runs its own
// purchase flow (no component interaction comes back to us). One action row
// (type 1) holds up to 5 buttons, so our three packs fit in a single row.
export function buyButtonRows(): unknown[] {
    return [
        {
            type: 1,
            components: CREDIT_PACKS.map((p) => ({ type: 2, style: 6, sku_id: p.skuId })),
        },
    ];
}
