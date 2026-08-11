// clank-email-forwarder — forwards mail sent to the contact address to a Gmail
// inbox. Wired as an SES receipt-rule action: SES writes the raw message to
// S3 (incoming/<messageId>), then invokes this Lambda, which rewrites the
// From/Reply-To headers (so SES will send it under the verified the verified domain
// domain, replies still go to the original sender) and re-sends via SES.
//
// Runtime nodejs20.x provides AWS SDK v3 — no bundled deps, the zip is just
// this file. Deploy: see the sibling deploy notes / project CLAUDE.md.

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SESClient, SendRawEmailCommand } = require('@aws-sdk/client-ses');

const REGION = 'us-east-1';
const BUCKET = 'clank-email-dev';
const PREFIX = 'incoming/';
const FROM = process.env.FORWARD_FROM || 'Clank <contact@example.com>'; // must be a verified SES identity
const TO = 'mdunn888@gmail.com';

const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

// Remove a header (incl. folded continuation lines) from a header block.
function stripHeader(headers, name) {
    const re = new RegExp(`^${name}:[^\\n]*(?:\\n[ \\t][^\\n]*)*\\n?`, 'gim');
    return headers.replace(re, '');
}

// SES scans inbound mail (ScanEnabled on the receipt rule) and reports verdicts.
// We MUST honour them: this forwarder strips the original DKIM-Signature and
// rewrites From: to the contact address, so anything we pass through arrives
// re-signed and DKIM/SPF-aligned as the verified domain — which would launder spoofed
// phishing and malware straight past Gmail's sender checks, on our domain's
// reputation. the contact address is published on the App Directory listing, so
// it will be scraped. Drop anything that fails.
const BLOCKING_VERDICTS = ['spamVerdict', 'virusVerdict', 'spfVerdict', 'dmarcVerdict'];

exports.handler = async (event) => {
    const record = event.Records[0].ses;
    const mail = record.mail;
    const receipt = record.receipt || {};

    const failed = BLOCKING_VERDICTS.filter((v) => receipt[v]?.status === 'FAIL');
    if (failed.length) {
        console.warn(`Dropped ${mail.messageId}: failed ${failed.join(', ')} (from ${mail.source})`);
        return { ok: true, dropped: true, failed };
    }

    const key = PREFIX + mail.messageId;

    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const raw = await streamToString(obj.Body);

    // Preserve the original sender so replies work.
    const fromMatch = raw.match(/^From:\s*(.*(?:\r?\n[ \t].*)*)/im);
    const origFrom = fromMatch ? fromMatch[1].replace(/\r?\n[ \t]+/g, ' ').trim() : TO;

    // Split headers from body at the first blank line.
    let idx = raw.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (idx === -1) {
        idx = raw.indexOf('\n\n');
        sepLen = 2;
    }
    let headers = idx === -1 ? raw : raw.slice(0, idx);
    const body = idx === -1 ? '' : raw.slice(idx + sepLen);

    // Strip headers that would conflict with re-sending, then set our own. The
    // X-SES-* ones matter for safety, not tidiness: SES *interprets* them in a
    // raw message (source/from/return-path ARNs, configuration set), so leaving
    // them in would let inbound mail steer our own send call.
    for (const name of [
        'From',
        'Return-Path',
        'Sender',
        'Message-ID',
        'DKIM-Signature',
        'Reply-To',
        'Bcc',
        'X-SES-SOURCE-ARN',
        'X-SES-FROM-ARN',
        'X-SES-RETURN-PATH-ARN',
        'X-SES-CONFIGURATION-SET',
    ]) {
        headers = stripHeader(headers, name);
    }
    headers = headers.replace(/\s+$/, '');

    const rawMessage = `From: ${FROM}\r\nReply-To: ${origFrom}\r\n${headers}\r\n\r\n${body}`;

    await ses.send(
        new SendRawEmailCommand({
            Destinations: [TO],
            RawMessage: { Data: Buffer.from(rawMessage) },
        })
    );

    return { ok: true, messageId: mail.messageId, from: origFrom };
};
