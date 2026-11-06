import { describe, expect, it } from 'vitest';
import { defaultLayers, readLayers } from './sceneLayers';

describe('scene layers', () => {
	it('starts on bare ground with every layer and the first atlas channel', () => {
		expect(defaultLayers(['prod', 'beta'])).toEqual({ terrain: 'bare', ortho: true, buildings: true, atlas: 'prod', atlasMiB: 64, names: true, readout: false });
		expect(defaultLayers([]).atlas).toBeNull();
	});

	it('keeps what was chosen', () => {
		const chosen = { terrain: 'surface', ortho: false, buildings: false, atlas: 'beta', atlasMiB: 256, names: false, readout: true };
		expect(readLayers(JSON.stringify(chosen), ['prod', 'beta'])).toEqual(chosen);
		expect(readLayers(JSON.stringify({ ...chosen, atlas: null }), ['prod']).atlas).toBeNull();
	});

	it('falls back field by field: a channel no longer offered, a bad value, a broken or absent record', () => {
		const r = readLayers(JSON.stringify({ terrain: 'dsm', ortho: false, atlas: 'gone' }), ['prod']);
		expect(r).toEqual({ terrain: 'bare', ortho: false, buildings: true, atlas: 'prod', atlasMiB: 64, names: true, readout: false });
		expect(readLayers('{not json', ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers(null, ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers('7', ['prod'])).toEqual(defaultLayers(['prod']));
	});

	it('takes the host\'s budget until the viewer chooses one, and only a budget on offer', () => {
		expect(readLayers(null, ['prod'], 16).atlasMiB).toBe(16);
		// a record saved before the budget joined the layers: the host's default, the rest as chosen
		expect(readLayers(JSON.stringify({ terrain: 'surface' }), ['prod'], 32)).toEqual({ ...defaultLayers(['prod'], 32), terrain: 'surface' });
		expect(readLayers(JSON.stringify({ atlasMiB: 512 }), ['prod'], 16).atlasMiB).toBe(512);
		for (const bad of [100, '64', 2048, 0, null]) expect(readLayers(JSON.stringify({ atlasMiB: bad }), ['prod'], 32).atlasMiB).toBe(32);
	});
});
