import { describe, expect, test } from 'vitest';
import { WorldRequests, RequestFailure, responseOrThrow, type RequestSpec } from './worldRequests';
const wait = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
function gate() {
	let resolve!: (value?: unknown) => void;
	const promise = new Promise(yes => { resolve = yes; });
	return { promise, resolve };
}
const spec = (id: string, run: RequestSpec['run'], priority = 0): RequestSpec =>
	({ id, url: `/tiles/${id}`, label: id, kind: 'terrain', priority, run });

describe('world desired-data scheduler', () => {
	test('lists all desired work and uses updated priorities when a slot opens', async () => {
		const q = new WorldRequests({ concurrency: 1 });
		const g = gate(); const started: string[] = [];
		const a = spec('a', async () => { started.push('a'); return g.promise; });
		const b = spec('b', async () => { started.push('b'); });
		const c = spec('c', async () => { started.push('c'); });
		q.reconcile('view', [a, { ...b, priority: 1 }, { ...c, priority: 2 }]);
		await wait();
		expect(q.snapshot().map(r => r.state)).toEqual(['loading', 'queued', 'queued']);
		q.reconcile('view', [a, { ...c, priority: 1 }, { ...b, priority: 2 }]);
		g.resolve(); await wait();
		expect(started).toEqual(['a', 'c', 'b']); q.dispose();
	});
	test('retries transient failures while the camera is stationary', async () => {
		const q = new WorldRequests({ retryMs: 5 }); let calls = 0;
		q.reconcile('view', [spec('a', async () => { if (++calls === 1) throw new Error('network'); })]);
		await wait(40);
		expect(calls).toBe(2); expect(q.snapshot()[0].state).toBe('loaded'); q.dispose();
	});
	test('movement cancels stale active and queued work and releases capacity', async () => {
		const q = new WorldRequests({ concurrency: 1 }); const started: string[] = [];
		q.reconcile('view', [spec('old', async () => { started.push('old'); await gate().promise; }), spec('never', async () => { started.push('never'); })]);
		await wait();
		q.reconcile('view', [spec('new', async () => { started.push('new'); })]);
		await wait();
		expect(started).toEqual(['old', 'new']);
		expect(q.snapshot().filter(r => !r.wanted).every(r => r.state === 'cancelled')).toBe(true); q.dispose();
	});
	test('HTTP 404 stays desired with a slow retry scheduled', async () => {
		const q = new WorldRequests({ retryMs: 1 }); let calls = 0;
		q.reconcile('view', [spec('a', async () => { calls++; throw new RequestFailure('HTTP 404', false); })]);
		await wait(20); const row = q.snapshot()[0];
		expect(calls).toBe(1); expect(row.state).toBe('retrying'); expect(row.wanted).toBe(true);
		expect(row.error).toBe('HTTP 404'); expect(row.retryAt! - row.startedAt!).toBeGreaterThanOrEqual(120_000); q.dispose();
	});
	test('desired reads recover after more than the former four attempts', async () => {
		const q = new WorldRequests({ retryMs: 1 }); let calls = 0;
		q.reconcile('view', [spec('a', async () => { if (++calls <= 6) throw new Error('busy'); })]);
		await wait(150); expect(calls).toBe(7); expect(q.snapshot()[0].state).toBe('loaded'); q.dispose();
	});
	test('timeouts become retries and stop at the retry budget', async () => {
		const q = new WorldRequests({ retryMs: 1 });
		q.reconcile('view', [{ ...spec('slow', async () => gate().promise), timeoutMs: 3, maxAttempts: 2 }]);
		await wait(40); const row = q.snapshot()[0];
		expect(row.state).toBe('failed'); expect(row.wanted).toBe(true); expect(row.attempts).toBe(2); expect(row.error).toContain('timed out'); q.dispose();
	});
	test('leaving a retrying tile cancels its retry timer', async () => {
		const q = new WorldRequests({ retryMs: 25 }); let calls = 0;
		q.reconcile('view', [spec('a', async () => { calls++; throw new Error('busy'); })]);
		await wait(); q.reconcile('view', []); await wait(40);
		expect(calls).toBe(1); expect(q.snapshot()[0].wanted).toBe(false); q.dispose();
	});
	test('one-shot reads return payloads, bound history and do not stay desired', async () => {
		const q = new WorldRequests({ historyLimit: 2 });
		for (let i = 0; i < 5; i++) expect(await q.request('world', { ...spec(String(i), async () => i), historyOnly: true })).toBe(i);
		expect(q.snapshot().length).toBeLessThanOrEqual(2); expect(q.snapshot().every(r => !r.wanted)).toBe(true); q.dispose();
	});
	test('revisiting an cancelled point selection loads fresh blocks', async () => {
		const q = new WorldRequests(); let calls = 0;
		const node = spec('node', async () => ++calls);
		q.reconcile('blocks', [node]); expect(await q.request('blocks', node)).toBe(1);
		q.reconcile('blocks', []); q.reconcile('blocks', [node]);
		expect(await q.request('blocks', node)).toBe(2); q.dispose();
	});
	test('a layer-owned cached tile is reused after leaving and returning', async () => {
		const q = new WorldRequests(); let calls = 0;
		const tile = { ...spec('tile', async () => { calls++; }), cacheable: true, onState: () => {} };
		q.reconcile('tiles', [tile]); await wait();
		q.reconcile('tiles', []); q.reconcile('tiles', [tile]); await wait();
		expect(calls).toBe(1); expect(q.snapshot()[0].wanted).toBe(true); expect(q.snapshot()[0].state).toBe('loaded'); q.dispose();
	});
	test('aborting an awaiting read returns AbortError rather than a completed payload', async () => {
		const q = new WorldRequests(); const abort = new AbortController();
		const result = q.request('world', spec('slow', async () => gate().promise), abort.signal);
		abort.abort();
		await expect(result).rejects.toMatchObject({ name: 'AbortError' });
		expect(q.snapshot()[0].state).toBe('cancelled'); q.dispose();
	});
	test('HTTP refusal retains API detail and Retry-After', async () => {
		const previous = globalThis.fetch;
		globalThis.fetch = (async () => new Response(JSON.stringify({ detail: 'Overpass is busy' }), { status: 503, headers: { 'Retry-After': '30' } })) as unknown as typeof fetch;
		try {
			await responseOrThrow('/map', new AbortController().signal).catch(error => {
				expect(error).toBeInstanceOf(RequestFailure); expect(error.message).toContain('Overpass is busy'); expect(error.retryAfterMs).toBe(30_000);
			});
		} finally { globalThis.fetch = previous; }
	});
});

test('an operation can make a non-transient read terminal on its first attempt', async () => {
	const q = new WorldRequests({ retryMs: 1 });
	const job = { ...spec('snapshot', async () => { throw new RequestFailure('snapshot pruned', false); }),
		maxAttempts: 3, retryWhen: (e: unknown) => e instanceof RequestFailure && e.retryable };
	await expect(q.request('copc',job)).rejects.toThrow('snapshot pruned');
	expect(q.snapshot()[0].state).toBe('failed');
	expect(q.snapshot()[0].attempts).toBe(1);
	q.dispose();
});
