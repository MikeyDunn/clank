// Unit tests for the pure image-byte helpers in lib/imageProcessor/upload.js.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectImageMime } from '../src/lib/imageProcessor/upload.js';

const bytes = (...b) => Buffer.from(b);

test('detectImageMime: JPEG magic bytes', () => {
    assert.equal(detectImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
});

test('detectImageMime: PNG magic bytes', () => {
    assert.equal(detectImageMime(bytes(0x89, 0x50, 0x4e, 0x47)), 'image/png');
});

test('detectImageMime: GIF magic bytes', () => {
    assert.equal(detectImageMime(bytes(0x47, 0x49, 0x46, 0x38)), 'image/gif');
});

test('detectImageMime: WebP needs RIFF (0-1) AND WEBP (8-9)', () => {
    // R I F F . . . . W E B P
    const webp = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    assert.equal(detectImageMime(webp), 'image/webp');
});

test('detectImageMime: RIFF without WEBP is NOT webp (AVI/WAV gotcha)', () => {
    // RIFF header but bytes 8-9 are not "WE" — must not match webp
    const avi = bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49, 0x20);
    assert.equal(detectImageMime(avi), null);
});

test('detectImageMime: unknown bytes return null', () => {
    assert.equal(detectImageMime(bytes(0x00, 0x01, 0x02, 0x03)), null);
});
