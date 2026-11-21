import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { AtlasCloud, atlasCredits, loadAtlases, loadTowns } from './atlasCloud';
import { CopcSource, type CopcChunk, type CopcNode } from './copcSource';
import { Frame } from './geodesy';
import { DENSE_CLOUD } from './worldClouds';
import { WorldRequests } from './worldRequests';

const KEY = '120f2464015ecdee';
const KEY2 = '6ebde34c0dda350d';
const BRANDYS = { id: 'ee1326e3-b779-42b7-86ca-7609b5f56a1d', label: 'Brandýs nad Labem' };
const SADSKA = { id: '0f8c2b8e-bc00-4029-8a9c-263d85939fb8', label: 'Sadská' };
const version = (over: Record<string, unknown> = {}) => ({
	schema: 2, key: KEY, resolution: 'full', built_at: 1, points: 10, town: BRANDYS, origin: [50.18, 14.66, 44.6], overlap: 'all',
	licence: { spdx: 'CC-BY-SA-4.0', name: 'x', url: 'u' }, credits: [{ text: 'Photographs: wegavision', url: null }],
	modified: 'm', runs: [], files: { tree: 'world.copc.laz', cameras: 'cameras.json' }, ...over
});
const entry = (town: typeof BRANDYS, key: string, over: Record<string, unknown> = {}) =>
	({ town, key, resolution: 'full', path: `w/full/${key}/`, built_at: 1, points: 10, ...over });

function site(files: Record<string, unknown>) {
	const asked: string[] = [];
	const f = (async (url: string) => {
		asked.push(url);
		const body = files[url.replace('https://atlas.example/', '')];
		return body === undefined ? new Response('no', { status: 404 }) : new Response(JSON.stringify(body));
	}) as typeof fetch;
	return { f, asked };
}

describe('loadAtlases', () => {
	it("follows the channel's towns pointer to each town's version and the files beside it", async () => {
		const { f, asked } = site({
			'prod.towns.json': { schema: 2, towns: [entry(BRANDYS, KEY), entry(SADSKA, KEY2)] },
			[`w/full/${KEY}/version.json`]: version(),
			[`w/full/${KEY2}/version.json`]: version({ key: KEY2, town: SADSKA, origin: [50.137, 14.984, 230.1] })
		});
		const { loaded: a, failed } = await loadAtlases('https://atlas.example/', 'prod', { fetch: f });
		expect(failed).toEqual([]);
		expect(a.map((x) => x.version.town.label)).toEqual(['Brandýs nad Labem', 'Sadská']);
		expect(a[1].treeUrl).toBe(`https://atlas.example/w/full/${KEY2}/world.copc.laz`);
		expect(a[1].camerasUrl).toBe(`https://atlas.example/w/full/${KEY2}/cameras.json`);
		expect(a[1].version.origin).toEqual([50.137, 14.984, 230.1]);
		expect(asked).toEqual(['https://atlas.example/prod.towns.json', `https://atlas.example/w/full/${KEY}/version.json`,
			`https://atlas.example/w/full/${KEY2}/version.json`]);
	});

	it('refuses a pointer at another path, a town twice, and a missing channel; a town whose version is wrong fails alone', async () => {
		const path = site({ 'prod.towns.json': { schema: 2, towns: [entry(BRANDYS, KEY, { path: 'w/full/0000000000000000/' })] } });
		await expect(loadTowns('https://atlas.example', 'prod', { fetch: path.f })).rejects.toThrow(/its own key/);
		const twice = site({ 'prod.towns.json': { schema: 2, towns: [entry(BRANDYS, KEY), entry(BRANDYS, KEY2)] } });
		await expect(loadTowns('https://atlas.example', 'prod', { fetch: twice.f })).rejects.toThrow(/Brandýs nad Labem twice/);
		const none = site({ 'prod.towns.json': { schema: 2, towns: [] } });
		await expect(loadTowns('https://atlas.example', 'prod', { fetch: none.f })).rejects.toThrow(/at least one town/);
		// the pointer of a single world, as published before towns, is not read
		const single = site({ 'prod.towns.json': { schema: 1, key: KEY, resolution: 'full', path: `w/full/${KEY}/` } });
		await expect(loadTowns('https://atlas.example', 'prod', { fetch: single.f })).rejects.toThrow(/schema-2/);
		// Brandys' version names another key, Sadska's folder is missing: both fail on their own, nothing loads
		const broken = site({
			'prod.towns.json': { schema: 2, towns: [entry(BRANDYS, KEY), entry(SADSKA, KEY2)] },
			[`w/full/${KEY}/version.json`]: version({ key: 'ffffffffffffffff' })
		});
		const none2 = await loadAtlases('https://atlas.example', 'prod', { fetch: broken.f });
		expect(none2.loaded).toEqual([]);
		expect(none2.failed.map((x) => x.entry.town.label)).toEqual(['Brandýs nad Labem', 'Sadská']);
		expect(none2.failed[0].error).toMatch(/another version/);
		expect(none2.failed[1].error).toMatch(/404/);
		// a version naming another town fails that town; the other still loads
		const one = site({
			'prod.towns.json': { schema: 2, towns: [entry(BRANDYS, KEY), entry(SADSKA, KEY2)] },
			[`w/full/${KEY}/version.json`]: version(),
			[`w/full/${KEY2}/version.json`]: version({ key: KEY2 })
		});
		const got = await loadAtlases('https://atlas.example', 'prod', { fetch: one.f });
		expect(got.loaded.map((x) => x.entry.town.label)).toEqual(['Brandýs nad Labem']);
		expect(got.failed.map((x) => x.error)).toEqual([expect.stringMatching(/than Sadská's/)]);
		await expect(loadAtlases('https://atlas.example', 'beta', { fetch: one.f })).rejects.toThrow(/404/);
	});
});

describe('atlasCredits', () => {
	const earth = [
		{ text: '© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', url: 'https://geoportal.cuzk.cz', licence: 'CC BY 4.0' },
		{ text: 'Copernicus WorldDEM-30 ...', url: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model', licence: 'c' },
		{ text: 'ČÚZK, 2024', url: 'https://geoportal.cuzk.gov.cz', licence: 'CC BY 4.0' }
	];
	const credits = [
		{ text: 'Photographs: wegavision, via Panoramax', url: 'https://panoramax.openstreetmap.fr' },
		{ text: '© OpenStreetMap contributors. Placements fitted in part ...', url: 'https://www.openstreetmap.org/copyright' },
		{ text: '© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0): heights fitted to the terrain', url: 'https://geoportal.cuzk.cz/' },
		{ text: 'produced using Copernicus WorldDEM-30 ...', url: 'https://spacedata.copernicus.eu/collections/copernicus-digital-elevation-model' },
		{ text: 'EGM2008 geoid', url: 'https://earth-info.nga.mil/' },
		{ text: 'a credit with no page', url: null }
	];
	type Versions = Parameters<typeof atlasCredits>[1];
	it("names each source once: the snapshot's terrain credits go where earth already names the page", () => {
		const c = atlasCredits(earth, [version({ credits })] as unknown as Versions);
		expect(c.map((x) => x.text)).toEqual(['© ČÚZK (DMR 5G / DMP 1G, CC BY 4.0)', 'Copernicus WorldDEM-30 ...', 'ČÚZK, 2024',
			'Point cloud: x', 'Photographs: wegavision, via Panoramax', '© OpenStreetMap contributors. Placements fitted in part ...',
			'EGM2008 geoid', 'a credit with no page']);
		expect(c.at(-1)).toEqual({ text: 'a credit with no page', url: 'u', licence: 'CC-BY-SA-4.0' });
	});

	it("two towns: the licence and the shared sources once, each town's own photographers", () => {
		const other = [{ text: 'Photographs: someone else, via Panoramax', url: 'https://panoramax.xyz' }, ...credits.slice(1)];
		const c = atlasCredits(earth, [version({ credits }), version({ key: KEY2, town: SADSKA, credits: other })] as unknown as Versions);
		const texts = c.map((x) => x.text);
		expect(texts.filter((t) => t === 'Point cloud: x')).toHaveLength(1);
		expect(texts.filter((t) => t.startsWith('© OpenStreetMap'))).toHaveLength(1);
		expect(texts).toContain('Photographs: wegavision, via Panoramax');
		expect(texts).toContain('Photographs: someone else, via Panoramax');
		expect(texts.indexOf('Photographs: someone else, via Panoramax')).toBeGreaterThan(texts.indexOf('a credit with no page'));
	});
});

describe('AtlasCloud: every town from one budget', () => {
	afterEach(() => { vi.restoreAllMocks(); });
	// four blocks a town, 400 points each, about the town's own origin; the budget holds 1,024 points
	const blocks = (prefix: string) => [
		{ key: '0-0-0-0', depth: 0, pointCount: 400, bounds: [-50, -50, -10, 50, 50, 30] },
		...['1-0-0-0', '1-1-0-0', '1-0-1-0'].map((key, i) =>
			({ key, depth: 1, pointCount: 400, bounds: [-50 + 30 * i, -50, -10, -20 + 30 * i, -20, 30] }))
	].map((n) => ({ ...n, tag: prefix }) as unknown as CopcNode);
	const chunk = (node: CopcNode): CopcChunk => {
		const n = node.pointCount, b = node.bounds, positions = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) positions.set([(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2], i * 3);
		return { positions, colors: new Uint8Array(n * 3), views: null, cloudTypes: new Uint8Array(n).fill(DENSE_CLOUD) };
	};
	const fake = (url: string) => {
		const nodes = blocks(url);
		return { select: () => nodes, load: async (node: CopcNode) => chunk(node), dispose: () => {} } as unknown as CopcSource;
	};
	const BRANDYS_AT = new Frame(50.187053, 14.660791, 230);
	const SADSKA_AT = new Frame(50.136861, 14.983786, 230);
	const settle = async (cloud: AtlasCloud) => {
		// each turn is a frame: the held blocks join the drawn ones before it renders, as the scene's draw does
		for (let i = 0; i < 200 && !cloud.idle; i++) {
			cloud.beforeRender();
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(cloud.idle).toBe(true);
	};
	const camera = () => {
		const c = new THREE.PerspectiveCamera(60, 1, 1, 2000);
		c.position.set(0, -80, 30);
		c.lookAt(0, 0, 0);
		return c;
	};

	it('a close look at one town takes the budget there; the far town gets only what is left', async () => {
		vi.spyOn(CopcSource, 'open').mockImplementation(async (url: string) => fake(url));
		const cloud = new AtlasCloud(THREE, { towns: [
			{ label: 'Brandýs nad Labem', treeUrl: 'b', frame: BRANDYS_AT },
			{ label: 'Sadská', treeUrl: 's', frame: SADSKA_AT }
		], scene: BRANDYS_AT, requests: new WorldRequests(), budgetMiB: (1024 * 24) / (1024 * 1024) });
		await cloud.open();
		expect(cloud.openTowns).toEqual([0, 1]);
		cloud.update(camera(), 600, false);
		await settle(cloud);
		const s = cloud.summary;
		// one budget: the two towns together within it, not each
		expect(s.points).toBeLessThanOrEqual(1024);
		expect(s.limited).toBeGreaterThan(0);
		// every Brandys block the plan wants came before any Sadska block (23 km off, beyond the camera's far plane)
		const held = (cloud as unknown as { residency: { resident: CopcNode[] } }).residency.resident.map((n) => n.key);
		expect(held[0].startsWith('0/')).toBe(true);
		expect(held.filter((k) => k.startsWith('0/')).length).toBeGreaterThan(held.filter((k) => k.startsWith('1/')).length);
		expect(cloud.error).toBeNull();
		cloud.dispose();
	});

	it('a town whose tree does not open is said, and the others draw', async () => {
		vi.spyOn(CopcSource, 'open').mockImplementation(async (url: string) => {
			if (url === 's') throw new Error('406 for s');
			return fake(url);
		});
		const cloud = new AtlasCloud(THREE, { towns: [
			{ label: 'Brandýs nad Labem', treeUrl: 'b', frame: BRANDYS_AT },
			{ label: 'Sadská', treeUrl: 's', frame: SADSKA_AT }
		], scene: BRANDYS_AT, requests: new WorldRequests(), budgetMiB: 1 });
		await cloud.open();
		expect(cloud.openTowns).toEqual([0]);
		expect(cloud.error).toBe('Sadská: 406 for s');
		cloud.update(camera(), 600, false);
		await settle(cloud);
		expect(cloud.summary.points).toBe(1600);
		cloud.dispose();
	});

	it('refuses to open when no town opens', async () => {
		vi.spyOn(CopcSource, 'open').mockImplementation(async (url: string) => { throw new Error(`404 for ${url}`); });
		const cloud = new AtlasCloud(THREE, { towns: [{ label: 'Sadská', treeUrl: 's', frame: SADSKA_AT }],
			scene: SADSKA_AT, requests: new WorldRequests() });
		await expect(cloud.open()).rejects.toThrow('Sadská: 404 for s');
		cloud.dispose();
	});
});
