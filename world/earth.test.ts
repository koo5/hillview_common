import { describe, expect, it } from 'vitest';
import { credits, layerUrls, loadEarth } from './earth';

const SOURCES = {
	cuzk: { text: '© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', url: 'https://geoportal.cuzk.cz', licence: 'CC BY 4.0' },
	glo30: { text: 'Copernicus WorldDEM-30', url: 'https://spacedata.copernicus.eu', licence: 'GLO-30' },
	etopo: { text: 'ETOPO 2022', url: 'https://doi.org/10.25921/fd45-gt74', licence: 'public domain' },
	'cuzk-ortho': { text: 'ČÚZK, {year}', url: 'https://geoportal.cuzk.gov.cz', licence: 'CC BY 4.0', terms_url: 'https://cuzk.gov.cz/terms' },
	osm: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright', licence: 'ODbL 1.0' },
	ipr: { text: 'datový podklad © IPR Praha', url: 'https://geoportalpraha.cz', licence: 'CC BY 4.0', terms_url: 'https://geoportalpraha.cz/terms',
		changes: 'I3S to GLB; EGM96 heights converted to WGS84 ellipsoidal heights' }
};

const EXTENT = [11.871954, 48.20489, 19.137774, 51.412049];
function earthStub(channel: Record<string, string>, orthoSources: Record<string, unknown> = { year: '2024-2025', extent: EXTENT }) {
	const asked: string[] = [];
	const f = (async (url: string) => {
		asked.push(url);
		const body = url.endsWith('/channels/prod') ? { name: 'prod', releases: channel }
			: url.endsWith('/attribution') ? { sources: SOURCES }
			: url.includes('/releases/') ? { id: 'o', layer: 'ortho', sources: orthoSources }
			: null;
		return body ? new Response(JSON.stringify(body)) : new Response('no', { status: 404 });
	}) as typeof fetch;
	return { f, asked };
}

describe('earth', () => {
	it('addresses every layer by its release id, never by the channel', () => {
		const u = layerUrls('https://earth.example/', { terrain: 'terrain-a', ortho: 'ortho-b', osm: 'osm-c', models: 'models-d', names: 'names-e' }, 'surface');
		expect(u.tileUrl).toBe('https://earth.example/t/terrain-a/terrain/surface/{z}/{x}/{y}.q16');
		expect(u.orthoUrl).toBe('https://earth.example/t/ortho-b/ortho/{z}/{x}/{y}.jpg');
		expect(u.osmUrl).toBe('https://earth.example/t/osm-c/osm/{z}/{x}/{y}.mvt');
		expect(u.modelsUrl).toBe('https://earth.example/t/models-d/models/manifest.json');
		expect(u.namesUrl).toBe('https://earth.example/t/names-e/names');
		expect(layerUrls('https://e', { terrain: 't' }, 'bare').tileUrl).toContain('/terrain/bare/');
		const none = layerUrls('https://e', { terrain: 't' }, 'bare');
		expect([none.orthoUrl, none.osmUrl, none.modelsUrl, none.namesUrl]).toEqual([undefined, undefined, undefined, undefined]);
	});

	it('refuses a channel without terrain', () => {
		expect(() => layerUrls('https://e', { ortho: 'o' }, 'bare')).toThrow(/no terrain/);
	});

	it('credits the terrain sources, then the orthophoto with its year, then the buildings: only what is drawn', () => {
		const c = credits(SOURCES, { orthoYear: '2024-2025' });
		expect(c.map((x) => x.text)).toEqual(['© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', 'Copernicus WorldDEM-30', 'ETOPO 2022',
			'ČÚZK, 2024-2025']);
		expect(c[3].terms_url).toBe('https://cuzk.gov.cz/terms');
		expect(credits(SOURCES, { orthoYear: null })).toHaveLength(3);
		expect(() => credits({ ...SOURCES, glo30: undefined } as never, { orthoYear: null })).toThrow(/glo30/);
		const all = credits(SOURCES, { orthoYear: '2024-2025', models: true });
		expect(all.at(-1)).toEqual({ text: 'datový podklad © IPR Praha', url: 'https://geoportalpraha.cz', licence: 'CC BY 4.0',
			terms_url: 'https://geoportalpraha.cz/terms', changes: 'I3S to GLB; EGM96 heights converted to WGS84 ellipsoidal heights' });
		expect(credits(SOURCES, { orthoYear: null, models: true }).map((x) => x.text).at(-2)).toBe('ETOPO 2022');
		expect(() => credits({ ...SOURCES, ipr: undefined } as never, { orthoYear: null, models: true })).toThrow(/ipr/);
		expect(credits(SOURCES, { orthoYear: null, names: true }).at(-1)?.text).toBe('© OpenStreetMap contributors');
	});

	it('loads a channel: its releases, sources and the ortho year and coverage', async () => {
		const { f, asked } = earthStub({ terrain: 'terrain-a', ortho: 'ortho-b', osm: 'osm-c' });
		const e = await loadEarth('https://earth.example/', 'prod', { fetch: f });
		expect(e).toEqual({ base: 'https://earth.example', releases: { terrain: 'terrain-a', ortho: 'ortho-b', osm: 'osm-c' },
			sources: SOURCES, orthoYear: '2024-2025', orthoExtent: EXTENT });
		expect(asked.sort()).toEqual(['https://earth.example/attribution', 'https://earth.example/channels/prod',
			'https://earth.example/releases/ortho-b']);
	});

	it('refuses an ortho release without its year or its coverage, and a missing channel', async () => {
		const { f } = earthStub({ terrain: 't', ortho: 'o' }, {});
		await expect(loadEarth('https://e', 'prod', { fetch: f })).rejects.toThrow(/no year/);
		for (const extent of [undefined, [1, 2, 3], [19, 48, 11, 51], [11, 48, 'e', 51]])
			await expect(loadEarth('https://e', 'prod', { fetch: earthStub({ terrain: 't', ortho: 'o' }, { year: '2024', extent }).f }))
				.rejects.toThrow(/no coverage box/);
		await expect(loadEarth('https://e', 'nope', { fetch: earthStub({ terrain: 't' }).f })).rejects.toThrow(/404/);
		await expect(loadEarth('https://e', 'prod', { fetch: earthStub({ ortho: 'o' }).f })).rejects.toThrow(/no terrain/);
	});
});
