import { afterEach, beforeEach, expect, test } from 'vitest';
import { CopcDecoder, type DecodeInput, type DecodeReply, type DecodeRequest } from './copcDecoder';

let messages: DecodeRequest[];
let terminated: boolean;
let fake: Worker;
let restore: () => void;
beforeEach(() => {
	messages = [];
	terminated = false;
	fake = {
		postMessage: (message: DecodeRequest, transfer: Transferable[] = []) => {
			messages.push(structuredClone(message, { transfer }));
		},
		terminate: () => { terminated = true; }
	} as unknown as Worker;
	const original = globalThis.Worker;
	globalThis.Worker = class { constructor() { return fake; } } as unknown as typeof Worker;
	restore = () => { globalThis.Worker = original; };
});
afterEach(() => restore());
const input = (): DecodeInput => ({ compressed: new Uint8Array([1, 2, 3]),
	header: {} as DecodeInput['header'], eb: [], pointCount: 1, hasViews: false });
const chunk = () => ({ positions: new Float32Array([1, 2, 3]), colors: new Uint8Array([200, 180, 160]), views: null });
const reply = (data: DecodeReply) => fake.onmessage!({ data } as MessageEvent<DecodeReply>);

test('transfers compressed ownership and routes out-of-order replies to the right jobs', async () => {
	const decoder = new CopcDecoder();
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
	const decoder = new CopcDecoder();
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
	const decoder = new CopcDecoder();
	const a = decoder.decode(input()), b = decoder.decode(input());
	decoder.dispose();
	expect(terminated).toBe(true);
	await expect(a).rejects.toHaveProperty('name', 'AbortError');
	await expect(b).rejects.toHaveProperty('name', 'AbortError');
	await expect(decoder.decode(input())).rejects.toHaveProperty('name', 'AbortError');
});
