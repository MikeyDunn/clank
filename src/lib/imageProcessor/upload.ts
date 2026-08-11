// ─── S3 upload + image-byte helpers ──────────────────────────────

import crypto from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

/**
 * Sniff an image MIME type from a raw buffer's magic bytes.
 * WebP needs bytes 0-1 (RIFF) AND 8-9 (WEBP) — 0-1 alone matches AVI/WAV.
 * Returns null when unrecognized (callers decide whether to default or reject).
 */
function detectImageMime(buf) {
    return buf[0] === 0xff && buf[1] === 0xd8
        ? 'image/jpeg'
        : buf[0] === 0x89 && buf[1] === 0x50
          ? 'image/png'
          : buf[0] === 0x47 && buf[1] === 0x49
            ? 'image/gif'
            : buf.length > 11 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45
              ? 'image/webp'
              : null;
}

const REGION = process.env.AWS_REGION || 'us-east-1';
const s3Client = new S3Client({ region: REGION });
const BUCKET_NAME = process.env.S3_BUCKET_NAME || 'clank-generated-images';

async function uploadImageToS3(base64Image, _prompt) {
    const matches = base64Image.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) throw new Error('Invalid base64 image format');

    const imageType = matches[1];
    const buffer = Buffer.from(matches[2], 'base64');
    // The bucket is anonymously readable (that's how Slack/Discord render the
    // image), so the KEY is the only thing protecting one tenant's renders from
    // another's. It used to be `<ms timestamp>-<8 hex of md5(prompt)>` — but the
    // prompt is echoed publicly in the Discord caption, so that's ~32 guessable
    // bits over known content inside a known time window. A random UUID isn't.
    const fileName = `${crypto.randomUUID()}.${imageType}`;

    await s3Client.send(
        new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: `image/${imageType}`,
            CacheControl: 'public, max-age=31536000',
        })
    );

    const publicUrl = `https://${BUCKET_NAME}.s3.${REGION}.amazonaws.com/${fileName}`;
    console.log('Image uploaded to S3:', publicUrl);
    return publicUrl;
}

export { detectImageMime, uploadImageToS3 };
