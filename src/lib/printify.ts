// ─── Printify integration ────────────────────────────────────────
// Upload designs, create t-shirt + sticker products on the Pop-Up Store.

const PRINTIFY_API = 'https://api.printify.com/v1';
const PRINTIFY_TOKEN = process.env.PRINTIFY_API_KEY;
const SHOP_ID = '26935066';

const headers = {
    Authorization: `Bearer ${PRINTIFY_TOKEN}`,
    'Content-Type': 'application/json',
};

/**
 * Thin wrapper over native fetch for the Printify API. `path` is the absolute
 * path portion after PRINTIFY_API (e.g. '/uploads/images.json'). Returns the
 * parsed JSON body (the equivalent of axios's `response.data`). Throws on any
 * non-2xx status with the status + a truncated body for context.
 *
 * Note: axios had per-call timeouts; fetch has none natively. Omitted here —
 * the Lambda's own 300s budget bounds the work.
 */
async function printifyApi(path: string, method: string, body?: any): Promise<any> {
    const res = await fetch(`${PRINTIFY_API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Printify ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return res.json();
}

// What a publish call syncs to the storefront. Every publish uses the full set.
const PUBLISH_PAYLOAD = {
    title: true,
    description: true,
    images: true,
    variants: true,
    tags: true,
    keyFeatures: true,
    shipping_template: true,
};

// Gildan Softstyle Unisex T-Shirt (Blueprint 145, Provider 99 - Printify Choice)
const BLUEPRINT_ID = 145;
const PRINT_PROVIDER_ID = 99;

// Die-Cut Stickers (Blueprint 600, Provider 73 - Printed Simply)
const STICKER_BLUEPRINT = 600;
const STICKER_PROVIDER = 73;

const MARKUP = 200; // $2 markup over cost (cents), shared by tee + sticker

/**
 * Fetch all catalog variants for a blueprint/provider combo.
 */
async function getVariants(blueprintId, providerId) {
    const result = await printifyApi(
        `/catalog/blueprints/${blueprintId}/print_providers/${providerId}/variants.json`,
        'GET'
    );
    return result.variants || [];
}

/**
 * Upload an image to Printify from a URL.
 */
async function uploadImage(imageUrl, fileName) {
    const result = await printifyApi(`/uploads/images.json`, 'POST', {
        file_name: fileName || 'clank-tshirt.png',
        url: imageUrl,
    });

    console.log('Printify image uploaded:', result.id);
    return result;
}

/**
 * Publish (or re-publish) a product to the Pop-Up Store storefront. Idempotent.
 * The Pop-Up Store snapshots mockups at publish time; the first publish (at create
 * time) fires before mockups have rendered, so createProductsFromImage calls this
 * again once mockups exist to push them into the storefront snapshot.
 */
async function publishProduct(productId) {
    await printifyApi(`/shops/${SHOP_ID}/products/${productId}/publish.json`, 'POST', PUBLISH_PAYLOAD);
}

/**
 * Create a product and fire the initial publish. Shared by tee + sticker — they
 * differ only in catalog ids, variants, copy, and print placement (y).
 */
async function createProduct({ title, description, tags, blueprintId, providerId, variants, imageId, y = 0.5 }) {
    const product = await printifyApi(`/shops/${SHOP_ID}/products.json`, 'POST', {
        title,
        description,
        tags,
        blueprint_id: blueprintId,
        print_provider_id: providerId,
        variants,
        print_areas: [
            {
                variant_ids: variants.map((v) => v.id),
                placeholders: [
                    {
                        position: 'front',
                        images: [{ id: imageId, x: 0.5, y, scale: 1, angle: 0 }],
                    },
                ],
            },
        ],
    });

    console.log('Printify product created:', product.id, product.title);

    // First publish — mockups may not be rendered yet; createProductsFromImage re-publishes.
    try {
        await publishProduct(product.id);
        console.log('Product published to storefront:', product.title);
    } catch (err) {
        console.error('Publish failed:', err.message);
    }

    return product;
}

/**
 * Create a t-shirt product (curated colors, all sizes) and publish.
 */
async function createTeeProduct(name, imageId) {
    const allVariants = await getVariants(BLUEPRINT_ID, PRINT_PROVIDER_ID);

    // Pick a curated set of colors, enable all sizes for each
    const wantColors = new Set([
        'Black',
        'White',
        'Navy',
        'Dark Heather',
        'Red',
        'Sport Grey',
        'Military Green',
        'Maroon',
        'Royal',
        'Charcoal',
        'Sand',
        'Light Blue',
    ]);
    const skipSizes = new Set(['3XL', '4XL', '5XL']);

    const variants = allVariants.map((v) => {
        const parts = v.title?.split(' / ') || [];
        const color = parts[0] || '';
        const size = parts[1] || '';
        return {
            id: v.id,
            price: (v.cost || 1200) + MARKUP,
            is_enabled: wantColors.has(color) && !skipSizes.has(size),
        };
    });

    const enabled = variants.filter((v) => v.is_enabled).length;
    console.log(`Creating tee with ${variants.length} variants (${enabled} enabled)`);

    return createProduct({
        title: name,
        description:
            'Custom t-shirt designed by Clank, the AI image generator for DallasDevs. Unisex Gildan Softstyle in multiple colors and sizes.',
        tags: ['clank', 'ai-art', 'dallasdevs', 'custom-tee'],
        blueprintId: BLUEPRINT_ID,
        providerId: PRINT_PROVIDER_ID,
        variants,
        imageId,
        y: 0.4,
    });
}

/**
 * Create a die-cut sticker product (all sizes enabled) and publish.
 */
async function createStickerProduct(name, imageId) {
    const allVariants = await getVariants(STICKER_BLUEPRINT, STICKER_PROVIDER);

    const variants = allVariants.map((v) => ({
        id: v.id,
        price: (v.cost || 500) + MARKUP,
        is_enabled: true,
    }));

    return createProduct({
        title: `${name} Sticker`,
        description: 'Die-cut sticker designed by Clank. Available in 2-6 sizes.',
        tags: ['clank', 'ai-art', 'dallasdevs', 'sticker'],
        blueprintId: STICKER_BLUEPRINT,
        providerId: STICKER_PROVIDER,
        variants,
        imageId,
        y: 0.5,
    });
}

/**
 * From a product detail, pick a FRONT mockup (design clearly visible) for a
 * RANDOM enabled color — not the folded 'other' flatlay Printify marks default,
 * which hides the art. Printify positions: 'front' (flat, design shown), 'back',
 * and 'other' (folded/lifestyle). Returns the mockup src, or null if none yet.
 */
function pickFrontMockup(detail: any): string | null {
    const enabledVariantIds = new Set((detail.variants || []).filter((v) => v.is_enabled).map((v) => v.id));
    const fronts = (detail.images || []).filter(
        (im) => im.position === 'front' && (im.variant_ids || []).some((id) => enabledVariantIds.has(id))
    );
    if (!fronts.length) return null;
    return fronts[Math.floor(Math.random() * fronts.length)].src;
}

/**
 * Full flow: upload design → create tee + sticker → publish both.
 */
async function createProductsFromImage(imageUrl, name) {
    const image = await uploadImage(imageUrl, `${name.replace(/[^a-z0-9]/gi, '-')}.png`);

    // Create both products in parallel
    const [tee, sticker] = await Promise.all([createTeeProduct(name, image.id), createStickerProduct(name, image.id)]);

    // Poll the tee until BOTH external.id (Pop-Up Store assigns it async after the
    // initial publish) AND mockups are ready. Mockups render from creation time, so
    // they're available well before external.id — gating on images.length here costs
    // no extra calls (we already fetch the detail) and guarantees the re-publish below
    // has something to sync. Without this, the storefront copy is born imageless.
    let storeUrl = 'https://clank.printify.me';
    let mockupsReady = false;
    let mockupUrl: string | null = null;
    for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const detail = await printifyApi(`/shops/${SHOP_ID}/products/${tee.id}.json`, 'GET');
            const external = detail.external;
            mockupsReady = (detail.images?.length || 0) > 0;
            if (mockupsReady && !mockupUrl) mockupUrl = pickFrontMockup(detail);
            if (external?.id && mockupsReady) {
                storeUrl = external.handle || `https://clank.printify.me/product/${external.id}`;
                console.log('Store URL:', storeUrl, `(after ${(i + 1) * 3}s, mockups ready)`);
                break;
            }
        } catch (err) {
            console.error('Failed to get store URL:', err.message);
        }
    }
    if (storeUrl === 'https://clank.printify.me') {
        console.warn('Store URL never populated — fell back to storefront root');
    }

    // Re-publish to push the now-rendered mockups into the storefront snapshot.
    // The first publish (at create time) raced ahead of mockup generation. Skip
    // only if mockups never showed up — re-publishing imageless would be pointless.
    if (mockupsReady) {
        try {
            await Promise.all([publishProduct(tee.id), publishProduct(sticker.id)]);
            console.log('Re-published tee + sticker to sync storefront mockups');
        } catch (err) {
            console.error('Mockup re-publish failed:', err.message);
        }
    } else {
        console.warn('Mockups not ready before timeout — skipped re-publish (storefront may show no image)');
    }

    return { tee, sticker, storeUrl, mockupUrl };
}

export { createProductsFromImage };
