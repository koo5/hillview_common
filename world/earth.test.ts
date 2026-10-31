import { describe, expect, it } from 'vitest';
import { credits, layerUrls, loadEarth } from './earth';

const SOURCES = {
	cuzk: { text: '© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', url: 'https://geoportal.cuzk.cz', licence: 'CC BY 4.0' },
	glo30: { text: 'Copernicus WorldDEM-30', url: 'https://spacedata.copernicus.eu', licence: 'GLO-30' },
	etopo: { text: 'ETOPO 2022', url: 'https://doi.org/10.25921/fd45-gt74', licence: 'public domain' },
	'cuzk-ortho': { text: 'ČÚZK, {year}', url: 'https://geoportal.cuzk.gov.cz', licence: 'CC BY 4.0', terms_url: 'https://cuzk.gov.cz/terms' }
};

function earthStub(channel: Record<string, string>, orthoSources: Record<string, string> = { year: '2024-2025' }) {
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
		const u = layerUrls('https://earth.example/', { terrain: 'terrain-a', ortho: 'ortho-b', osm: 'osm-c' });
		expect(u.tileUrl).toBe('https://earth.example/t/terrain-a/terrain/surface/{z}/{x}/{y}.q16');
		expect(u.orthoUrl).toBe('https://earth.example/t/ortho-b/ortho/{z}/{x}/{y}.jpg');
		expect(u.osmUrl).toBe('https://earth.example/t/osm-c/osm/{z}/{x}/{y}.mvt');
		expect(layerUrls('https://e', { terrain: 't' }, 'bare').tileUrl).toContain('/terrain/bare/');
		expect(layerUrls('https://e', { terrain: 't' }).orthoUrl).toBeUndefined();
	});

	it('refuses a channel without terrain', () => {
		expect(() => layerUrls('https://e', { ortho: 'o' })).toThrow(/no terrain/);
	});

	it('credits the terrain sources, then the orthophoto with its year', () => {
		const c = credits(SOURCES, '2024-2025');
		expect(c.map((x) => x.text)).toEqual(['© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', 'Copernicus WorldDEM-30', 'ETOPO 2022',
			'ČÚZK, 2024-2025']);
		expect(c[3].terms_url).toBe('https://cuzk.gov.cz/terms');
		expect(credits(SOURCES, null)).toHaveLength(3);
		expect(() => credits({ ...SOURCES, glo30: undefined } as never, null)).toThrow(/glo30/);
	});

	it('loads a channel: its releases, URLs and credits', async () => {
		const { f, asked } = earthStub({ terrain: 'terrain-a', ortho: 'ortho-b', osm: 'osm-c' });
		const e = await loadEarth('https://earth.example', 'prod', { fetch: f });
		expect(e.releases.terrain).toBe('terrain-a');
		expect(e.orthoUrl).toContain('/t/ortho-b/');
		expect(e.credits.at(-1)?.text).toBe('ČÚZK, 2024-2025');
		expect(asked.sort()).toEqual(['https://earth.example/attribution', 'https://earth.example/channels/prod',
			'https://earth.example/releases/ortho-b']);
	});

	it('refuses an ortho release without its year, and a missing channel', async () => {
		const { f } = earthStub({ terrain: 't', ortho: 'o' }, {});
		await expect(loadEarth('https://e', 'prod', { fetch: f })).rejects.toThrow(/no year/);
		await expect(loadEarth('https://e', 'nope', { fetch: earthStub({ terrain: 't' }).f })).rejects.toThrow(/404/);
	});
});
