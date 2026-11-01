import { describe, expect, it } from 'vitest';
import { loadAtlas } from './atlasCloud';

const KEY = '120f2464015ecdee';
const version = (over: Record<string, unknown> = {}) => ({
	schema: 1, key: KEY, resolution: 'full', built_at: 1, points: 10, origin: [50.18, 14.66, 44.6], overlap: 'all',
	licence: { spdx: 'CC-BY-SA-4.0', name: 'x', url: 'u' }, credits: [{ text: 'Photographs: wegavision', url: null }],
	modified: 'm', runs: [], files: { tree: 'world.copc.laz', cameras: 'cameras.json' }, ...over
});

function site(files: Record<string, unknown>) {
	const asked: string[] = [];
	const f = (async (url: string) => {
		asked.push(url);
		const body = files[url.replace('https://atlas.example/', '')];
		return body === undefined ? new Response('no', { status: 404 }) : new Response(JSON.stringify(body));
	}) as typeof fetch;
	return { f, asked };
}

describe('loadAtlas', () => {
	it('follows the channel pointer to its version and the files beside it', async () => {
		const { f, asked } = site({
			'prod.json': { schema: 1, key: KEY, resolution: 'full', path: `w/full/${KEY}/`, built_at: 1, points: 10 },
			[`w/full/${KEY}/version.json`]: version()
		});
		const a = await loadAtlas('https://atlas.example/', 'prod', { fetch: f });
		expect(a.treeUrl).toBe(`https://atlas.example/w/full/${KEY}/world.copc.laz`);
		expect(a.camerasUrl).toBe(`https://atlas.example/w/full/${KEY}/cameras.json`);
		expect(a.version.licence.spdx).toBe('CC-BY-SA-4.0');
		expect(asked).toEqual(['https://atlas.example/prod.json', `https://atlas.example/w/full/${KEY}/version.json`]);
	});

	it('refuses a pointer at another path, a version of another key, and a missing channel', async () => {
		const bad = site({ 'prod.json': { schema: 1, key: KEY, resolution: 'full', path: 'w/full/0000000000000000/' } });
		await expect(loadAtlas('https://atlas.example', 'prod', { fetch: bad.f })).rejects.toThrow(/its own key/);
		const other = site({
			'prod.json': { schema: 1, key: KEY, resolution: 'full', path: `w/full/${KEY}/` },
			[`w/full/${KEY}/version.json`]: version({ key: 'ffffffffffffffff' })
		});
		await expect(loadAtlas('https://atlas.example', 'prod', { fetch: other.f })).rejects.toThrow(/another version/);
		await expect(loadAtlas('https://atlas.example', 'beta', { fetch: other.f })).rejects.toThrow(/404/);
	});
});
