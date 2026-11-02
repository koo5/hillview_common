import { afterEach, describe, expect, it } from 'vitest';
import { Frame } from './geodesy';
import { LabelPool } from './labelPool';
import { sampleTile } from './terrainTiles';

describe('the ground under a name', () => {
	it('samples a tile bilinearly, and says nothing where it has no value or no tile', () => {
		const n = 65, z = 15, x = 17718, y = 11086;
		const h = new Float32Array(n * n);
		for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) h[r * n + c] = 100 + c + 2 * r;
		const k = 2 ** z;
		const lon = ((x + 0.25) / k) * 360 - 180;
		const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / k))) * 180) / Math.PI;
		expect(sampleTile(h, n, z, x, y, lat, lon)!).toBeCloseTo(100 + 16 + 64, 3);
		expect(sampleTile(h, n, z, x + 1, y, lat, lon)).toBeNull();
		h.fill(Number.NaN);
		expect(sampleTile(h, n, z, x, y, lat, lon)).toBeNull();
	});
});

describe('the pool round the camera', () => {
	const real = globalThis.fetch;
	afterEach(() => { globalThis.fetch = real; });

	it('streams nearest chunk first, and stands every name on the drawn ground where that is higher', async () => {
		const frame = new Frame(50, 14, 300);
		const asked: string[] = [];
		globalThis.fetch = (async (u: string) => {
			asked.push(u);
			const chunk = Number(new URL(u, 'http://x').searchParams.get('chunk'));
			const labels = chunk === 0
				? [{ name: 'Low', kind: 'peak', lat: 50.01, lon: 14, h: 350, ele: 305, prominence: 40 },
					{ name: 'High', kind: 'peak', lat: 50.02, lon: 14, h: 600, ele: 555 },
					{ name: 'Nowhere', kind: 'village', lat: 50.03, lon: 14, h: null }]
				: [];
			return new Response(JSON.stringify({ labels }));
		}) as typeof fetch;
		let done!: () => void;
		const finished = new Promise<void>((r) => (done = r));
				const pool = new LabelPool({ url: '/api/terrain/labels', frame, chunks: 2,
			onChange: () => { if (pool.version >= 2 && !pool.stats.loading) done(); } });
		pool.update([0, 0, 0]);
		await finished;
		expect(asked.map((u) => new URL(u, 'http://x').searchParams.get('chunk'))).toEqual(['0', '1']);
		const ground = () => 400; // drawn ground at 400 m everywhere
		const list = pool.named(ground, 1, [0, 0, 0]);
		const by = Object.fromEntries(list.map((n) => [n.name, n]));
		expect(Object.keys(by).sort()).toEqual(['High', 'Low']);
		expect(frame.toGeodetic(...by.Low.s)[2]).toBeCloseTo(400, 3);   // lifted out of the hill
		expect(frame.toGeodetic(...by.High.s)[2]).toBeCloseTo(600, 3);  // already above it
		expect(by.Low.text).toBe('Low 305');
		expect(by.Low.priority).toBe(40);
		// moving less than the recentre distance asks nothing more
		pool.update(frame.fromGeodetic(50.05, 14, 300));
		expect(asked.length).toBe(2);
	});
});
