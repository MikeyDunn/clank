// ─── T-shirt subsystem ───────────────────────────────────────────
// Merch flow, separate from Clank's core art flow (index.ts). Takes an
// existing Clank image → green-screen shirt design → chroma-key to a
// transparent PNG → Printify product. Two triggers:
//   • tshirtMode      — explicit "make a shirt" (interactionHandler)
//   • tshirtReaction  — 4+ 👕 reactions on a Clank image (eventHandler)

import sharp from 'sharp';
import { generateImage } from '../../../imageProcessor/generate.js';
import { parseResponse } from '../../../imageProcessor/parse.js';
import { detectImageMime, uploadImageToS3 } from '../../../imageProcessor/upload.js';
import { getItem, updateItem } from '../../../memory/db.js';
import * as openrouter from '../../../openrouter.js';
import { createProductsFromImage } from '../../../printify.js';
import { fetchMessage, isOwnMessage, postMessage } from '../index.js';
import { deriveProductName, pickProductName } from './productName.js';

/**
 * T-shirt reaction: when a Clank image gets 4+ 👕 reactions, auto-create a product.
 */
async function processTshirtReaction(event) {
    const { channelId, messageTs } = event;

    try {
        // Get the message to find the image and check reaction count
        // (thread-reply-safe, so 👕 works on threaded Ask Clank sends too).
        const message = await fetchMessage(channelId, messageTs);
        if (!message) return { statusCode: 200, body: 'Message not found' };

        // Count shirt reactions
        const shirtReactions = (message.reactions || [])
            .filter((r) => r.name === 'tshirt' || r.name === 'shirt')
            .reduce((sum, r) => sum + r.count, 0);

        console.log('Shirt reactions on message:', shirtReactions);
        if (shirtReactions < 4) return { statusCode: 200, body: 'Not enough reactions' };

        // Find the image URL from the message blocks
        const imageBlock = message.blocks?.find((b) => b.type === 'image');
        if (!imageBlock?.image_url) return { statusCode: 200, body: 'No image in message' };

        // Extract prompt from context block
        const contextBlock = message.blocks?.find((b) => b.type === 'context');
        const contextText = contextBlock?.elements?.[0]?.text || '';
        const promptMatch = contextText.match(/\*([^*]+)\*/);
        // Summon-path posts carry no *prompt* in the context line — Clank's
        // thoughts live in the image alt_text, a better naming seed than a stub.
        const altText = (imageBlock.alt_text || '').trim();
        const prompt = promptMatch ? promptMatch[1].replace(/^["']|["']$/g, '') : altText.slice(0, 300) || 'Clank art';

        // Check if this is a Clank image: HIS message carrying his S3 image.
        // Identity via auth.test (isOwnMessage) — subtype bot_message only
        // exists on response_url posts, not chat.postMessage (summon/thread).
        const isClankImage =
            (await isOwnMessage(message)) && imageBlock.image_url?.includes('clank-image-generator-images');
        if (!isClankImage) {
            console.log('Not a Clank image — skipping t-shirt');
            return { statusCode: 200, body: 'Not a Clank image' };
        }

        // Check if we already made a shirt for this image
        const shirtLog = await getItem('META', 'SHIRT_LOG');
        const shirtedUrls = shirtLog?.urls || [];
        if (shirtedUrls.includes(imageBlock.image_url)) {
            console.log('T-shirt already created for this image');
            return { statusCode: 200, body: 'Already created' };
        }

        // Log this image URL so we never create a duplicate shirt
        await updateItem({
            Key: { pk: 'META', sk: 'SHIRT_LOG' },
            UpdateExpression: 'SET #urls = list_append(if_not_exists(#urls, :empty), :newUrl)',
            ExpressionAttributeNames: { '#urls': 'urls' },
            ExpressionAttributeValues: { ':empty': [], ':newUrl': [imageBlock.image_url] },
        });

        // Post public "making your shirt" message
        await postMessage(channelId, {
            thread_ts: messageTs,
            reply_broadcast: true,
            text: '👕 This image got 4 shirt votes! Making a t-shirt...',
        });

        // Generate the shirt (reuse processTshirt)
        await processTshirt({
            prompt,
            channelId,
            userId: 'system',
            originalImageUrl: imageBlock.image_url,
            publicPost: true,
            threadTs: messageTs,
        });

        return { statusCode: 200, body: 'Tshirt reaction processed' };
    } catch (error) {
        console.error('Tshirt reaction error:', error.message);
        return { statusCode: 200, body: 'Error' };
    }
}

/**
 * T-shirt mode: take an existing image, generate a shirt-ready version, create a Printify product.
 */
async function processTshirt(event) {
    const { prompt, channelId, originalImageUrl, threadTs = null } = event;
    const send = (payload) =>
        postMessage(channelId, { ...payload, ...(threadTs && { thread_ts: threadTs, reply_broadcast: true }) });

    try {
        // Download the original image to pass as reference
        let referenceBase64: string | null = null;
        try {
            const buf = Buffer.from(await (await fetch(originalImageUrl)).arrayBuffer());
            const detectedMime = detectImageMime(buf) || 'image/png';
            referenceBase64 = `data:${detectedMime};base64,${buf.toString('base64')}`;
            console.log('Tshirt reference image downloaded:', `${Math.round(buf.length / 1024)}KB`);
        } catch (err) {
            console.error('Failed to download reference for tshirt:', err.message);
        }

        // Generate shirt design with original image as reference
        const shirtPrompt = `Convert this image into a t-shirt graphic on a solid bright green (#00FF00) chroma key background. Stay as faithful as possible to the original design — same art style, same composition, same elements, same colors. Extract the core graphic from the image and reproduce it cleanly as an isolated design element. Centered composition, clean edges, no background scene. The entire background must be solid #00FF00 green. Leave at least 50 pixels of solid green padding on ALL four sides — nothing should touch or get cut off at any edge. Match the original as closely as you can.\n\nOriginal prompt for context: "${prompt}"`;

        // Use gpt-5-image (not mini) for higher fidelity to the reference
        console.log('Tshirt generating with reference image (gpt-5-image)');
        const genResult = await generateImage(shirtPrompt, referenceBase64, 'openai/gpt-5-image');
        if (genResult.error) {
            console.error('Tshirt generate error:', genResult.error.response?.data || genResult.error.message);
            await send({ text: "⚠️ Couldn't generate the shirt design. Try again." });
            return { statusCode: 200, body: 'Tshirt generate failed' };
        }

        const result = parseResponse(genResult.response, genResult.startTime);
        console.log('Tshirt parse result:', result.outcome, result.errorType || '', result.message || '');
        if (result.outcome !== 'success') {
            await send({ text: "⚠️ The image model couldn't create a shirt design for this." });
            return { statusCode: 200, body: 'Tshirt no image' };
        }

        // Remove green background → transparent PNG using sharp Lambda layer
        const base64Data = (result.imageUrl || '').replace(/^data:image\/\w+;base64,/, '');
        const imgBuffer = Buffer.from(base64Data, 'base64');

        const { data: rawPixels, info } = await sharp(imgBuffer)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });

        // Chroma key: replace green (#00FF00) pixels with transparent
        for (let i = 0; i < rawPixels.length; i += 4) {
            const r = rawPixels[i],
                g = rawPixels[i + 1],
                b = rawPixels[i + 2];
            const greenDominance = g - Math.max(r, b);
            if (greenDominance > 50) {
                // Strong green — fully transparent
                rawPixels[i + 3] = 0;
            } else if (greenDominance > 20) {
                // Edge — partial transparency for anti-aliasing
                rawPixels[i + 3] = Math.max(0, Math.round(255 * (1 - greenDominance / 80)));
            }
        }

        const transparentPng = await sharp(rawPixels, { raw: { width: info.width, height: info.height, channels: 4 } })
            .png()
            .toBuffer();

        console.log('Green screen removed:', `${Math.round(transparentPng.length / 1024)}KB transparent PNG`);

        const transparentBase64 = `data:image/png;base64,${transparentPng.toString('base64')}`;
        const publicUrl = await uploadImageToS3(transparentBase64, `tshirt-${prompt}`);
        console.log('Shirt design uploaded:', publicUrl);

        // Name the shirt with a quick Haiku call. The naming logic (cleaning the
        // model's output, validating it, and deriving a prompt-based fallback) is
        // pure — see productName.js — so here we only do the I/O.
        let productName = deriveProductName(prompt);
        try {
            const nameResponse = await openrouter.chat(
                {
                    model: 'anthropic/claude-haiku-4.5',
                    messages: [
                        {
                            role: 'system',
                            content:
                                'You generate t-shirt product titles. Output ONLY the title — 2 to 5 words, Title Case, no quotes, no punctuation, no preamble, no explanation, no parentheses. Just the title.',
                        },
                        { role: 'user', content: `Image prompt: ${prompt}` },
                    ],
                    max_tokens: 40,
                    temperature: 0.7,
                },
                10000
            );
            const raw = nameResponse.choices?.[0]?.message?.content?.trim() || '';
            productName = pickProductName(raw, prompt);
            console.log('Shirt name:', productName);
        } catch (err) {
            console.error('Naming failed, using fallback:', err.message);
        }
        const { storeUrl, mockupUrl } = await createProductsFromImage(publicUrl, productName);

        if (mockupUrl) {
            // Printify's API won't let us change the storefront's default mockup (the
            // folded flatlay that hides the art), so a native unfurl of the store link
            // is stuck showing it. Instead we build our own unfurl-style card via a
            // Slack attachment: a FRONT mockup in a random color, titled + linked to
            // the store. Native unfurl disabled so Slack doesn't also append the folded one.
            await send({
                text: `👕 ${productName}`,
                unfurl_links: false,
                unfurl_media: false,
                attachments: [
                    {
                        color: '#2eb67d',
                        title: productName,
                        title_link: storeUrl,
                        image_url: mockupUrl,
                        footer: 'Clank Merch',
                    },
                ],
            });
        } else {
            await send({ text: storeUrl });
        }

        return { statusCode: 200, body: 'Tshirt created' };
    } catch (error) {
        console.error('Tshirt error:', error.response?.data || error.message || error);
        try {
            await send({ text: '⚠️ Something went wrong creating the t-shirt. Try again.' });
        } catch (err) {
            console.error('Failed to send tshirt error:', err);
        }
        return { statusCode: 500, body: 'Tshirt error' };
    }
}

export { processTshirt, processTshirtReaction };
