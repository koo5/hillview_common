import { describe, expect, test, vi } from 'vitest';
import { digestHex, sha256Hex } from './sha256';

const enc = (s: string) => new TextEncoder().encode(s);
/** n random bytes, filled in 64 KiB pieces: Web Crypto (Node, browsers) refuses more in one getRandomValues call */
const random = (n: number) => {
	const b = new Uint8Array(n);
	for (let at = 0; at < n; at += 65_536) crypto.getRandomValues(b.subarray(at, Math.min(n, at + 65_536)));
	return b;
};
const subtle = async (b: Uint8Array<ArrayBuffer>) =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map(n => n.toString(16).padStart(2, '0')).join('');

describe('sha256Hex', () => {
	test("FIPS 180-4's vectors", () => {
		expect(sha256Hex(enc(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
		expect(sha256Hex(enc('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		expect(sha256Hex(enc('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))
			.toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
		expect(sha256Hex(new Uint8Array(1_000_000).fill(0x61)))
			.toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
	});

	test("every length across the padding's edges, and random bytes, agree with crypto.subtle", async () => {
		// 55/56 and 63/64/65 bytes are where the padding takes one block or two
		const lengths = [...Array(200).keys(), 447, 448, 511, 512, 513, 4095, 4096, 65_537, 921_516];
		for (const n of lengths) {
			const b = random(n);
			expect(sha256Hex(b)).toBe(await subtle(b));
		}
	});

	test("digestHex without crypto.subtle (a page over plain http) gives crypto.subtle's answer", async () => {
		const b = random(70_001);
		const want = await subtle(b);
		expect(await digestHex(b)).toBe(want);
		// an insecure context's crypto: getRandomValues, and no subtle
		vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
		try {
			expect(globalThis.crypto.subtle).toBeUndefined();
			expect(await digestHex(b)).toBe(want);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(typeof globalThis.crypto.subtle?.digest).toBe('function');
	});

	test('a view into a larger buffer hashes its own bytes only', async () => {
		const big = random(1000);
		const view = big.subarray(100, 777);
		expect(sha256Hex(view)).toBe(await subtle(view.slice()));
	});
});
