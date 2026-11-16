/**
 * SHA-256 of a download, as lowercase hex, on every origin.
 *
 * crypto.subtle exists only in a secure context (https, localhost). The workbench is also opened over plain http (a
 * phone reaching it by address), where every city-model mesh failed on "Cannot read properties of undefined (reading
 * 'digest')" instead of loading. So digestHex uses crypto.subtle where the browser has it (native, off the main
 * thread) and sha256Hex, plain TypeScript, where it does not. The two give the same answer (sha256.test.ts compares
 * them on every length across the padding's edges). This checks a download against the hash its manifest names; it
 * is not used for anything secret.
 * sha256Hex's cost, on the main thread: about 7.5 ms per MB in V8 on a desktop (16 ms for the city models' largest
 * mesh, 2.2 MB), more on a phone. That is why a secure context keeps crypto.subtle.
 */
export async function digestHex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) return sha256Hex(bytes);
	return [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 (FIPS 180-4) in plain TypeScript, as lowercase hex: digestHex's answer where the browser has no digest. */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

export function sha256Hex(data: Uint8Array): string {
	const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
	const w = new Uint32Array(64);
	// the message's whole 64-byte blocks are read in place; the tail, the 0x80 byte and the bit length go in one or
	// two padding blocks
	const whole = data.length - (data.length % 64);
	const tailLen = data.length - whole;
	const pad = new Uint8Array(tailLen < 56 ? 64 : 128);
	pad.set(data.subarray(whole));
	pad[tailLen] = 0x80;
	const bits = data.length * 8;
	const pv = new DataView(pad.buffer);
	pv.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
	pv.setUint32(pad.length - 4, bits >>> 0);
	const block = (bytes: Uint8Array, at: number) => {
		for (let i = 0; i < 16; i++) {
			const j = at + i * 4;
			w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
		}
		for (let i = 16; i < 64; i++) {
			const a = w[i - 15], b = w[i - 2];
			const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
			const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
			w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
		}
		let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const t1 = (k + S1 + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
			k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
		}
		h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
	};
	for (let at = 0; at < whole; at += 64) block(data, at);
	for (let at = 0; at < pad.length; at += 64) block(pad, at);
	let hex = '';
	for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
	return hex;
}
