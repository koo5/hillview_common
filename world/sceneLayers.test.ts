import { describe, expect, it } from 'vitest';
import { defaultLayers, groundSources, readLayers } from './sceneLayers';

describe('scene layers', () => {
	it('starts on bare ground with every layer and the first atlas channel', () => {
		expect(defaultLayers(['prod', 'beta'])).toEqual({ terrain: 'bare', terrainShown: true, ortho: true, models: true,
			osmBuildings: true, osmRoads: true, osmWalls: true, osmWater: true,
			atlas: 'prod', atlasMiB: 64, atlasSizing: { nearPx: 1.5, farPx: 4, kneeM: 100 }, cameras: false, names: true,
			readout: false });
		expect(defaultLayers([]).atlas).toBeNull();
	});

	it('keeps what was chosen', () => {
		const chosen = { terrain: 'surface', terrainShown: false, ortho: false, models: false, osmBuildings: true, osmRoads: false,
			osmWalls: false, osmWater: true,
			atlas: 'beta', atlasMiB: 256, atlasSizing: { nearPx: 1, farPx: 6, kneeM: 250 }, cameras: true, names: false,
			readout: true };
		expect(readLayers(JSON.stringify(chosen), ['prod', 'beta'])).toEqual(chosen);
		expect(readLayers(JSON.stringify({ ...chosen, atlas: null }), ['prod']).atlas).toBeNull();
	});

	it('falls back field by field: a channel no longer offered, a bad value, a broken or absent record', () => {
		const r = readLayers(JSON.stringify({ terrain: 'dsm', ortho: false, atlas: 'gone' }), ['prod']);
		expect(r).toEqual({ terrain: 'bare', terrainShown: true, ortho: false, models: true, osmBuildings: true, osmRoads: true,
			osmWalls: true, osmWater: true,
			atlas: 'prod', atlasMiB: 64, atlasSizing: { nearPx: 1.5, farPx: 4, kneeM: 100 }, cameras: false, names: true,
			readout: false });
		// a sizing read field by field: a value off its range takes its own initial one
		expect(readLayers(JSON.stringify({ atlasSizing: { nearPx: 99, farPx: 8, kneeM: '7' } }), ['prod']).atlasSizing)
			.toEqual({ nearPx: 1.5, farPx: 8, kneeM: 100 });
		// the one Buildings layer of before (city models, else OSM) is no longer read: each layer on its own default
		expect(readLayers(JSON.stringify({ buildings: false }), ['prod'])).toEqual(defaultLayers(['prod']));
		// the cameras are off unless chosen, and a record from before they joined the layers keeps them off
		expect(readLayers(JSON.stringify({ cameras: 'yes' }), ['prod']).cameras).toBe(false);
		expect(readLayers('{not json', ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers(null, ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers('7', ['prod'])).toEqual(defaultLayers(['prod']));
	});

	it('builds the ground from the photo\'s choice alone: hiding the terrain reads nothing again', () => {
		const urls = { tileUrl: 'https://earth.example/t/1/terrain/bare/{z}/{x}/{y}.q16', orthoUrl: 'https://earth.example/t/2/ortho/{z}/{x}/{y}.jpg' };
		// what it reads is what the scene's ground effect depends on: the photo's choice, never the terrain's visibility
		const read = new Set<string | symbol>();
		const watched = new Proxy({ ...defaultLayers(['prod']), terrainShown: false }, { get: (t, k) => { read.add(k); return Reflect.get(t, k); } });
		expect(groundSources(watched, urls)).toEqual(urls);
		expect([...read]).toEqual(['ortho']);
		expect(groundSources({ ortho: false }, urls)).toEqual({ tileUrl: urls.tileUrl, orthoUrl: undefined });
		expect(groundSources({ ortho: true }, null)).toEqual({ tileUrl: undefined, orthoUrl: undefined });
	});

	it('takes the host\'s budget until the viewer chooses one, and only a budget on offer', () => {
		expect(readLayers(null, ['prod'], 16).atlasMiB).toBe(16);
		// a record saved before the budget joined the layers: the host's default, the rest as chosen
		expect(readLayers(JSON.stringify({ terrain: 'surface' }), ['prod'], 32)).toEqual({ ...defaultLayers(['prod'], 32), terrain: 'surface' });
		expect(readLayers(JSON.stringify({ atlasMiB: 512 }), ['prod'], 16).atlasMiB).toBe(512);
		for (const bad of [100, '64', 2048, 0, null]) expect(readLayers(JSON.stringify({ atlasMiB: bad }), ['prod'], 32).atlasMiB).toBe(32);
	});
});
