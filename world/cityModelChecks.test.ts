import { afterEach, describe, expect, test, vi } from 'vitest';
import { checkCityAsset, type CityAsset } from './cityModelTiles';
import { sha256Hex } from './sha256';

/** the smallest GLB validateCityGlb takes: the header, a JSON chunk declaring the layout, and an empty BIN chunk */
function glb(triangles: number): ArrayBuffer {
	const acc = { count: triangles * 3, type: 'VEC3', componentType: 5126 };
	const doc = { asset: { version: '2.0', generator: 'ipr-i3s-glb-v1' }, buffers: [{ byteLength: 0 }],
		meshes: [{}], nodes: [{}], accessors: [acc, acc, acc] };
	const text = new TextEncoder().encode(JSON.stringify(doc));
	const n = Math.ceil(text.length / 4) * 4;
	const out = new Uint8Array(20 + n + 8).fill(0x20, 20, 20 + n);
	out.set(text, 20);
	const v = new DataView(out.buffer);
	v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, out.length, true);
	v.setUint32(12, n, true); v.setUint32(16, 0x4e4f534a, true);
	v.setUint32(20 + n, 0, true); v.setUint32(24 + n, 0x004e4942, true);
	return out.buffer;
}
const asOf = (bytes: ArrayBuffer, sha256: string): CityAsset => ({ id: 'ipr/1/1/0', url: `assets/${sha256}.glb`, sha256,
	bytes: bytes.byteLength, triangles: 2, anchor: [50.09, 14.4, 324], radius: 100, node: '1' });

describe('a downloaded city-model mesh, checked before it is parsed', () => {
	afterEach(() => vi.unstubAllGlobals());

	test('takes a mesh whose bytes match its sha256, and refuses one whose bytes do not', async () => {
		const bytes = glb(2);
		await expect(checkCityAsset(bytes, asOf(bytes, sha256Hex(new Uint8Array(bytes))))).resolves.toBeUndefined();
		await expect(checkCityAsset(bytes, asOf(bytes, 'b'.repeat(64)))).rejects.toThrow('City-model asset checksum mismatch');
	});

	test('the same over plain http, where the page has no crypto.subtle (every mesh failed there)', async () => {
		const bytes = glb(2);
		const good = sha256Hex(new Uint8Array(bytes));
		vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
		expect(globalThis.crypto.subtle).toBeUndefined();
		// an ArrayBuffer, as the download hands it over
		await expect(checkCityAsset(bytes, asOf(bytes, good))).resolves.toBeUndefined();
		await expect(checkCityAsset(bytes, asOf(bytes, 'b'.repeat(64)))).rejects.toThrow('City-model asset checksum mismatch');
	});
});
