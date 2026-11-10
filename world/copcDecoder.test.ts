import { afterEach, beforeEach, expect, test } from 'vitest';
import { CopcDecoder, decoderCount, type DecodeInput, type DecodeReply, type DecodeRequest } from './copcDecoder';

type Fake = Worker & { sent: DecodeRequest[]; terminated: boolean };
let messages: DecodeRequest[];
let fakes: Fake[];
let restore: () => void;
beforeEach(() => {
	messages = [];
	fakes = [];
	const original = globalThis.Worker;
	globalThis.Worker = class {
		constructor() {
			const fake = {
				sent: [] as DecodeRequest[], terminated: false,
				postMessage: (message: DecodeRequest, transfer: Transferable[] = []) => {
					const copy = structuredClone(message, { transfer });
					messages.push(copy); fake.sent.push(copy);
				},
				terminate: () => { fake.terminated = true; }
			} as unknown as Fake;
			fakes.push(fake);
			return fake;
		}
	} as unknown as typeof Worker;
	restore = () => { globalThis.Worker = original; };
});
afterEach(() => restore());
const input = (): DecodeInput => ({ compressed: new Uint8Array([1, 2, 3]),
	header: {} as DecodeInput['header'], eb: [], pointCount: 1, hasViews: false });
const chunk = () => ({ positions: new Float32Array([1, 2, 3]), colors: new Uint8Array([200, 180, 160]), views: null });
const reply = (data: DecodeReply, worker = 0) => fakes[worker].onmessage!({ data } as MessageEvent<DecodeReply>);
const ids = (fake: Fake) => fake.sent.map(m => ('id' in m ? m.id : -m.cancel));

test('transfers compressed ownership and routes out-of-order replies to the right jobs', async () => {
	const decoder = new CopcDecoder(1);
	const first = input();
	const a = decoder.decode(first), b = decoder.decode(input());
	expect(first.compressed.byteLength).toBe(0);
	expect(messages).toHaveLength(2);
	const output = chunk();
	reply({ id: 2, chunk: output });
	reply({ id: 1, error: 'malformed chunk' });
	await expect(b).resolves.toBe(output);
	await expect(a).rejects.toThrow('malformed chunk');
	decoder.dispose();
});

test('cancellation rejects immediately and ignores a late worker reply', async () => {
	const decoder = new CopcDecoder(1);
	const abort = new AbortController();
	const result = decoder.decode(input(), abort.signal);
	abort.abort();
	await expect(result).rejects.toHaveProperty('name', 'AbortError');
	expect(messages[1]).toEqual({ cancel: 1 });
	reply({ id: 1, chunk: chunk() });
	const next = decoder.decode(input());
	reply({ id: 2, chunk: chunk() });
	await expect(next).resolves.toHaveProperty('views', null);
	decoder.dispose();
});

test('disposing terminates the worker and rejects every outstanding and future job', async () => {
	const decoder = new CopcDecoder(1);
	const a = decoder.decode(input()), b = decoder.decode(input());
	decoder.dispose();
	expect(fakes[0].terminated).toBe(true);
	await expect(a).rejects.toHaveProperty('name', 'AbortError');
	await expect(b).rejects.toHaveProperty('name', 'AbortError');
	await expect(decoder.decode(input())).rejects.toHaveProperty('name', 'AbortError');
});

test('blocks decode side by side: a worker per busy job up to the size, then the least busy', async () => {
	const decoder = new CopcDecoder(3);
	const jobs = [0, 1, 2, 3, 4].map(() => decoder.decode(input()));
	for (const job of jobs) job.catch(() => {});
	expect(decoder.workers).toBe(3);
	expect(fakes.map(ids)).toEqual([[1, 4], [2, 5], [3]]);
	// each reply comes from the worker that holds its job
	reply({ id: 5, chunk: chunk() }, 1);
	reply({ id: 3, chunk: chunk() }, 2);
	await expect(jobs[4]).resolves.toHaveProperty('views', null);
	await expect(jobs[2]).resolves.toHaveProperty('views', null);
	// worker 2 is idle again: the next job goes there, no fourth worker
	void decoder.decode(input()).catch(() => {});
	expect(ids(fakes[2])).toEqual([3, 6]);
	expect(fakes).toHaveLength(3);
	decoder.dispose();
	expect(fakes.every(f => f.terminated)).toBe(true);
	await expect(jobs[0]).rejects.toHaveProperty('name', 'AbortError');
});

test('a worker is made only when every worker is busy', async () => {
	const decoder = new CopcDecoder(4);
	for (let id = 1; id <= 3; id++) {
		const job = decoder.decode(input());
		reply({ id, chunk: chunk() });
		await job;
	}
	expect(decoder.workers).toBe(1);
	decoder.dispose();
});

test('a cancel goes to the worker that holds the job, and frees it', async () => {
	const decoder = new CopcDecoder(2);
	const abort = new AbortController();
	const a = decoder.decode(input()), b = decoder.decode(input(), abort.signal);
	abort.abort();
	await expect(b).rejects.toHaveProperty('name', 'AbortError');
	expect(ids(fakes[1])).toEqual([2, -2]);
	expect(ids(fakes[0])).toEqual([1]);
	void decoder.decode(input()).catch(() => {});
	expect(ids(fakes[1])).toEqual([2, -2, 3]);
	reply({ id: 1, chunk: chunk() });
	await expect(a).resolves.toHaveProperty('views', null);
	decoder.dispose();
});

test('a failing worker fails every job of the source', async () => {
	const decoder = new CopcDecoder(2);
	const a = decoder.decode(input()), b = decoder.decode(input());
	fakes[1].onerror!({ message: 'out of memory' } as ErrorEvent);
	await expect(a).rejects.toThrow('COPC decoder worker failed: out of memory');
	await expect(b).rejects.toThrow('COPC decoder worker failed: out of memory');
	expect(fakes.every(f => f.terminated)).toBe(true);
});

test('half the cores decode, one to four', () => {
	// NaN: a browser that does not say (the default reads navigator.hardwareConcurrency)
	expect([Number.NaN, 0, 1, 2, 3, 4, 8, 16, 64].map(n => decoderCount(n, 8))).toEqual([1, 1, 1, 1, 1, 2, 4, 4, 4]);
	// a device that says it has less than 8 GiB runs two at most; one that says nothing is taken at its cores
	expect([[8, 4], [8, 2], [2, 0.5], [8, Number.NaN], [12, undefined]].map(([c, m]) => decoderCount(c, m)))
		.toEqual([2, 2, 1, 4, 4]);
	expect(() => new CopcDecoder(0)).toThrow('at least one worker');
});
