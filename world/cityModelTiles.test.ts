import { describe, expect, test } from 'vitest';
import { Frame } from './geodesy';
import { MAX_BYTES, MAX_TRIANGLES, selectCityAssets, validateManifest, type CityAsset } from './cityModelTiles';

const sha = 'a'.repeat(64);
const asset: CityAsset = { id: 'ipr/1/925/0', url: `assets/${sha}.glb`, sha256: sha, bytes: 1000,
	triangles: 10, anchor: [50.09, 14.4, 324], radius: 100, node: '925' };
const manifest = () => ({ schema: 2, revision: '1', generator: 'ipr-i3s-glb-v1', output_datum: 'WGS84 ellipsoidal',
	areas: [{ sha256: sha, lat: 50.09, lon: 14.4, radius: 600 }], assets: [{ ...asset, anchor: [...asset.anchor] }],
	credit: { title: 'IPR', attribution: 'datový podklad © IPR Praha', source_url: 'https://geoportalpraha.cz/',
		license: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/', changes: 'converted' } });
const url = 'http://localhost:8094/api/terrain/citymodels/manifest.json';

describe('prepared city-model admission', () => {
	test('requires explicit ellipsoidal datum and same-origin immutable assets', () => {
		expect(validateManifest(manifest(), url).assets).toHaveLength(1);
		for (const mutate of [
			(m: ReturnType<typeof manifest>) => { m.output_datum = 'EGM96'; },
			(m: ReturnType<typeof manifest>) => { m.assets[0].url = `https://elsewhere.example/${sha}.glb`; },
			(m: ReturnType<typeof manifest>) => { m.assets[0].anchor[0] = NaN; },
			(m: ReturnType<typeof manifest>) => { m.assets[0].triangles = 1_000_000; },
			(m: ReturnType<typeof manifest>) => { m.assets.push(m.assets[0]); },
			(m: ReturnType<typeof manifest>) => { m.schema = 1; },
			(m: ReturnType<typeof manifest>) => { m.areas = []; }
		]) { const m = manifest(); mutate(m); expect(() => validateManifest(m, url)).toThrow(); }
	});
	test('selection drops distant/behind meshes and bounds triangles and resident bytes', () => {
		const frame = new Frame(50.09, 14.4, 324);
		const assets = Array.from({ length: 90 }, (_, i) => ({ ...asset, id: String(i), triangles: 30_000, bytes: 3_240_000 }));
		const { desired, capped } = selectCityAssets(assets, frame, [0, -50, 0], { dir: [0, 1, 0], fovY: 60, aspect: 1, heightPx: 800 });
		expect(desired.reduce((n, a) => n + a.triangles, 0)).toBeLessThanOrEqual(MAX_TRIANGLES);
		expect(desired.reduce((n, a) => n + a.bytes, 0)).toBeLessThanOrEqual(MAX_BYTES);
		expect(desired.length).toBe(50);                          // 50 x 30k: the triangle budget binds
		expect(capped).toBe(90 - desired.length);
		expect(selectCityAssets([asset], frame, [0, 500, 0], { dir: [0, 1, 0], fovY: 60, aspect: 1, heightPx: 800 }).desired).toHaveLength(0);
		expect(selectCityAssets([asset], frame, [0, -5000, 0], { dir: [0, 1, 0], fovY: 60, aspect: 1, heightPx: 800 }).desired).toHaveLength(0);
	});
});
