import { describe, expect, it } from 'vitest';
import { defaultLayers, readLayers } from './sceneLayers';

describe('scene layers', () => {
	it('starts on bare ground with every layer and the first atlas channel', () => {
		expect(defaultLayers(['prod', 'beta'])).toEqual({ terrain: 'bare', ortho: true, buildings: true, atlas: 'prod' });
		expect(defaultLayers([]).atlas).toBeNull();
	});

	it('keeps what was chosen', () => {
		const chosen = { terrain: 'surface', ortho: false, buildings: false, atlas: 'beta' };
		expect(readLayers(JSON.stringify(chosen), ['prod', 'beta'])).toEqual(chosen);
		expect(readLayers(JSON.stringify({ ...chosen, atlas: null }), ['prod']).atlas).toBeNull();
	});

	it('falls back field by field: a channel no longer offered, a bad value, a broken or absent record', () => {
		const r = readLayers(JSON.stringify({ terrain: 'dsm', ortho: false, atlas: 'gone' }), ['prod']);
		expect(r).toEqual({ terrain: 'bare', ortho: false, buildings: true, atlas: 'prod' });
		expect(readLayers('{not json', ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers(null, ['prod'])).toEqual(defaultLayers(['prod']));
		expect(readLayers('7', ['prod'])).toEqual(defaultLayers(['prod']));
	});
});
