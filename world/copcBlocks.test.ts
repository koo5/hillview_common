import { expect, test, vi } from 'vitest';
import { blockTimeoutMs, readBlocks } from './copcBlocks';
import { WorldRequests } from './worldRequests';
import type { CopcChunk, CopcNode, CopcSource } from './copcSource';

const chunk = (n: number): CopcChunk => ({ positions: new Float32Array(n * 3), colors: new Uint8Array(n * 3), views: null, cloudTypes: null });
const nodes = ['0-0-0-0', '1-0-0-0', '1-1-0-0'].map((key, i) => ({ key, depth: i ? 1 : 0, pointCount: i + 1 }) as unknown as CopcNode);

test('blocks are read through the scheduler and handed over in order', async () => {
	const loaded: string[] = [];
	const source = { load: async (node: CopcNode) => { loaded.push(node.key); return chunk(node.pointCount); } } as unknown as CopcSource;
	const requests = new WorldRequests();
	const scope = requests.scope('points');
	const seen: (string | number)[][] = [];
	await readBlocks(source, nodes, { url: 'https://atlas.example/w/full/k/world.copc.laz', requests, scope,
		signal: new AbortController().signal, before: (i) => { seen.push(['before', i]); },
		each: async (i, node, c) => { seen.push([i, node.key, c.positions.length / 3]); } });
	expect(seen).toEqual([['before', 0], [0, '0-0-0-0', 1], ['before', 1], [1, '1-0-0-0', 2], ['before', 2], [2, '1-1-0-0', 3]]);
	expect(loaded.sort()).toEqual(['0-0-0-0', '1-0-0-0', '1-1-0-0']);
	expect(requests.snapshot().filter((r) => r.kind === 'points').length).toBe(3);
});

test('a hung block is given up by its size and read again, not waited on for three minutes (ea14)', async () => {
	vi.useFakeTimers();
	try {
		let calls = 0;
		const source = { load: (node: CopcNode) => { calls++;
			return calls === 1 ? new Promise<CopcChunk>(() => {}) : Promise.resolve(chunk(node.pointCount)); } } as unknown as CopcSource;
		const requests = new WorldRequests({ retryMs: 1000 });
		const seen: string[] = [];
		const done = readBlocks(source, [nodes[0]], { url: 'u', requests, scope: requests.scope('points'),
			signal: new AbortController().signal, each: async (_i, node) => { seen.push(node.key); } });
		await vi.advanceTimersByTimeAsync(blockTimeoutMs(nodes[0]) - 1);
		expect(seen).toEqual([]);
		await vi.advanceTimersByTimeAsync(1 + 1000 + 10);   // the deadline, then the first retry's back-off
		await done;
		expect(seen).toEqual(['0-0-0-0']);
		expect(calls).toBe(2);
	} finally { vi.useRealTimers(); }
	expect(blockTimeoutMs({ pointCount: 100_000 })).toBe(18_000);
	expect(blockTimeoutMs({ pointCount: 1_000_000 })).toBeLessThan(180_000);
});

test('without a scheduler the blocks are loaded directly, in order', async () => {
	const source = { load: async (node: CopcNode) => chunk(node.pointCount) } as unknown as CopcSource;
	const seen: string[] = [];
	await readBlocks(source, nodes, { url: 'u', requests: null, scope: '', signal: new AbortController().signal,
		each: async (_i, node) => { seen.push(node.key); } });
	expect(seen).toEqual(['0-0-0-0', '1-0-0-0', '1-1-0-0']);
});
