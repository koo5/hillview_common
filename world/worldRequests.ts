/** Desired world data, scheduling and diagnostics share this registry. No global fetch patching. */
export type RequestState = 'queued' | 'loading' | 'retrying' | 'loaded' | 'cancelled' | 'failed';
export type RequestKind = 'world' | 'terrain' | 'ortho' | 'map' | 'models' | 'labels' | 'points' | 'cameras' | 'images';
export type RequestInfo = {
	id: string; scope: string; label: string; kind: RequestKind; url: string;
	priority: number; wanted: boolean; state: RequestState; attempts: number;
	createdAt: number; startedAt?: number; finishedAt?: number; retryAt?: number;
	error?: string; reason?: string; detail?: string; serverId?: string;
};
export type RequestSpec<T = unknown> = {
	id: string; label: string; kind: RequestKind; url: string; priority?: number; detail?: string;
	/** Reads retry while desired; explicitly bound operations that cannot safely repeat. */
	timeoutMs?: number; maxAttempts?: number;
	/** An operation may make non-transient failures terminal instead of slow rechecks. */
	retryWhen?: (error: unknown) => boolean;
	run: (signal: AbortSignal, requestId: string) => Promise<T>;
	onState?: (state: RequestState) => void;
	historyOnly?: boolean;
	/** False for resources without API stage telemetry, such as image URLs. */
	observeServer?: boolean;
	/** The layer owns a reusable cache of this completed payload. */
	cacheable?: boolean;
};
type Job = { info: RequestInfo; spec: RequestSpec<any>; controller?: AbortController;
	promise: Promise<any>; resolve: (value: any) => void; reject: (error: unknown) => void; settled: boolean };
/** retryable marks transient errors; other read failures receive slow rechecks while desired. */
export class RequestFailure extends Error {
	constructor(message: string, readonly retryable = true, readonly retryAfterMs?: number) { super(message); }
}
const abortError = (reason: string) => new DOMException(reason, 'AbortError');
const ACTIVE = new Set<RequestState>(['queued', 'loading', 'retrying']);

// crypto.randomUUID exists only in a SECURE context (https, localhost), and the workbench is served
// over plain http on :8765 -- the phone reaches it that way over Yggdrasil -- where it threw on every
// page holding a viewer (found 2026-10-12 by the live Playwright tier). getRandomValues is everywhere.
function randomId(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class WorldRequests {
	private jobs = new Map<string, Job>();
	private listeners = new Set<() => void>();
	private running = new Map<RequestKind, number>();
	private timer?: ReturnType<typeof setTimeout>;
	private serial = 0;
	private instance = randomId();
	private disposed = false;
	constructor(private options: { concurrency?: number; retryMs?: number; historyLimit?: number;
		limits?: Partial<Record<RequestKind, number>> } = {}) {}

	scope(prefix: string) { return `${prefix}:${++this.serial}`; }
	subscribe(listener: () => void) { this.listeners.add(listener); listener(); return () => { this.listeners.delete(listener); }; }
	snapshot(): RequestInfo[] { return [...this.jobs.values()].map(j => ({ ...j.info })); }

	/** Replace a layer's complete desired set, in its current spatial priority order. */
	reconcile(scope: string, specs: RequestSpec[]) {
		const wanted = new Set(specs.map(s => s.id));
		for (const job of this.jobs.values()) {
			if (job.info.scope === scope && job.info.wanted && !wanted.has(job.spec.id)) this.cancel(job, 'outside the desired area');
		}
		for (const [priority, spec] of specs.entries()) this.ensure(scope, { ...spec, priority: spec.priority ?? priority });
		this.changed();
		this.pump();
	}

	/** An explicit one-shot read (metadata, a binary range, etc.), using the same scheduler. */
	request<T>(scope: string, spec: RequestSpec<T>, signal?: AbortSignal): Promise<T> {
		if (this.disposed || signal?.aborted) return Promise.reject(signal?.reason ?? abortError('viewer closed'));
		const job = this.ensure(scope, spec);
		const abort = () => { this.cancel(job, 'cancelled by its owner'); this.pump(); };
		signal?.addEventListener('abort', abort, { once: true });
		this.changed();
		this.pump();
		return job.promise.finally(() => signal?.removeEventListener('abort', abort));
	}

	private ensure(scope: string, spec: RequestSpec): Job {
		const key = `${scope}|${spec.id}`;
		let job = this.jobs.get(key);
		if (job && (job.info.wanted || (job.info.state === 'loaded' && !!job.spec.cacheable))) {
			job.spec = spec;
			job.info.priority = spec.priority ?? 0;
			job.info.wanted = true;
			return job;
		}
		let resolve!: Job['resolve'], reject!: Job['reject'];
		const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
		// Reconciled resources have no awaiting caller; failures still appear in the registry.
		void promise.catch(() => {});
		job = { spec, promise, resolve, reject, settled: false, info: {
			id: key, scope, label: spec.label, kind: spec.kind, url: spec.url,
			priority: spec.priority ?? 0, detail: spec.detail, wanted: true, state: 'queued', attempts: 0, createdAt: Date.now()
		} };
		this.jobs.set(key, job);
		return job;
	}

	private state(job: Job, state: RequestState) { job.info.state = state; job.spec.onState?.(state); this.changed(); }
	private cancel(job: Job, reason: string) {
		job.info.wanted = false;
		if (job.info.state === 'loaded') { this.retire(job); return; }
		job.info.reason = reason;
		job.info.retryAt = undefined;
		job.info.finishedAt = Date.now();
		job.controller?.abort(abortError(reason));
		this.state(job, 'cancelled');
		if (!job.settled) { job.settled = true; job.reject(abortError(reason)); }
		this.retire(job);
	}

	release(scope: string, reason = 'layer turned off') {
		for (const job of this.jobs.values()) if (job.info.scope === scope) this.cancel(job, reason);
		this.changed(); this.pump();
	}
	forget(scope: string, id: string) { const key = `${scope}|${id}`; const job = this.jobs.get(key);
		if (job && job.info.state !== 'loading') this.jobs.delete(key); }
	retry(id: string) {
		const job = this.jobs.get(id);
		if (!job?.info.wanted || job.info.state === 'loading' || job.info.state === 'loaded') return;
		job.info.attempts = 0; job.info.error = undefined; job.info.reason = undefined; job.info.retryAt = undefined;
		this.state(job, 'queued'); this.pump();
	}

	private pump() {
		if (this.disposed) return;
		clearTimeout(this.timer);
		const now = Date.now();
		const queued = [...this.jobs.values()].filter(j => j.info.wanted &&
			(j.info.state === 'queued' || (j.info.state === 'retrying' && (j.info.retryAt ?? 0) <= now)))
			.sort((a, b) => a.info.priority - b.info.priority || a.info.createdAt - b.info.createdAt);
		const limits = { map: 3, models: 2, terrain: 6, ortho: 6, labels: 1, points: 3, cameras: 2, world: 3, images: 3, ...this.options.limits };
		for (const job of queued) {
			const total = [...this.running.values()].reduce((a, b) => a + b, 0);
			if (total >= (this.options.concurrency ?? 12)) break;
			if ((this.running.get(job.info.kind) ?? 0) >= limits[job.info.kind]) continue;
			void this.start(job);
		}
		const retries = [...this.jobs.values()].filter(j => j.info.wanted && j.info.state === 'retrying' && (j.info.retryAt ?? 0) > now);
		if (retries.length) this.timer = setTimeout(() => this.pump(), Math.max(1, Math.min(...retries.map(j => j.info.retryAt!)) - now));
	}

	private async start(job: Job) {
		const kind = job.info.kind;
		this.running.set(kind, (this.running.get(kind) ?? 0) + 1);
		const controller = new AbortController();
		job.controller = controller;
		const requestId = `${this.instance}-${++this.serial}`;
		job.info.serverId = job.spec.observeServer === false ? undefined : requestId;
		job.info.attempts++; job.info.startedAt = Date.now(); job.info.finishedAt = undefined; job.info.retryAt = undefined;
		this.state(job, 'loading');
		const timeout = setTimeout(() => controller.abort(new RequestFailure('request timed out')), job.spec.timeoutMs ?? 180_000);
		try {
			// Race enforces a deadline even for a decoder/provider that ignores AbortSignal.
			const value = await new Promise((resolve, reject) => {
				controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
				Promise.resolve().then(() => job.spec.run(controller.signal, requestId)).then(resolve, reject);
			});
			if (!job.info.wanted || controller.signal.aborted) return;
			job.info.finishedAt = Date.now(); job.info.error = undefined; job.info.reason = undefined;
			this.state(job, 'loaded');
			if (!job.settled) { job.settled = true; job.resolve(job.spec.onState ? undefined : value); }
			if (job.spec.historyOnly) {
				job.info.wanted = false;
				this.retire(job);
				this.changed();
			}
		} catch (error) {
			if (!job.info.wanted || job.info.state === 'cancelled') return;
			job.info.error = error instanceof Error ? error.message : String(error);
			const retryable = !(error instanceof RequestFailure) || error.retryable;
			if (job.info.attempts < (job.spec.maxAttempts ?? Infinity) && (job.spec.retryWhen?.(error) ?? true)) {
				const delay = error instanceof RequestFailure ? error.retryAfterMs : undefined;
				job.info.retryAt = Date.now() + Math.max(delay ?? 0, retryable ? Math.min(120_000, (this.options.retryMs ?? 5000) * 2 ** Math.min(30, job.info.attempts - 1)) : 120_000);
				this.state(job, 'retrying');
			} else {
				job.info.reason = 'automatic retries stopped for this operation; still desired';
				job.info.finishedAt = Date.now();
				this.state(job, 'failed');
				if (!job.settled) { job.settled = true; job.reject(error); }
			}
		} finally {
			clearTimeout(timeout); job.controller = undefined;
			this.running.set(kind, (this.running.get(kind) ?? 1) - 1);
			this.prune(); this.pump();
		}
	}
	/** Keep diagnostic metadata without retaining payloads, decoders or disposed layer closures. */
	private retire(job: Job) {
		job.promise = Promise.resolve(undefined);
		job.resolve = () => {}; job.reject = () => {};
		job.spec = { ...job.spec, onState: undefined, run: async () => undefined };
	}

	private prune() {
		const history = [...this.jobs.values()].filter(j => !j.info.wanted && !ACTIVE.has(j.info.state))
			.sort((a, b) => (b.info.finishedAt ?? b.info.createdAt) - (a.info.finishedAt ?? a.info.createdAt));
		for (const job of history.slice(this.options.historyLimit ?? 200)) this.jobs.delete(job.info.id);
	}
	private changed() { for (const listener of this.listeners) listener(); }
	dispose() { this.disposed = true; clearTimeout(this.timer);
		for (const job of this.jobs.values()) this.cancel(job, 'viewer closed'); this.listeners.clear(); }
}

/** Read a complete HTTP payload inside a task, so “loaded” never just means headers arrived. */
export async function responseOrThrow(url: string, signal: AbortSignal, init?: RequestInit): Promise<Response> {
	const response = await fetch(url, { ...init, signal });
	if (response.ok) return response;
	let detail = `HTTP ${response.status} ${response.statusText}`.trim();
	try { const body = await response.json(); if (body.detail) detail += `: ${typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)}`; } catch { /* proxy error */ }
	const retry = response.status === 408 || response.status === 429 || response.status >= 500;
	const after = response.headers.get('Retry-After');
	const retryAfterMs = after ? (/^\d+$/.test(after) ? Number(after) * 1000 : Math.max(0, Date.parse(after) - Date.now())) : undefined;
	throw new RequestFailure(detail, retry, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
}

export type ResourceRead = <T>(url: string, init: RequestInit | undefined, read: (response: Response) => Promise<T>) => Promise<T>;
export function resourceReader(requests: WorldRequests, scope: string, maxAttempts?: number, retryWhen?: RequestSpec['retryWhen']): ResourceRead {
	let serial = 0;
	return (url, init, read) => {
		const { kind, label } = describeRequest(url);
		return requests.request(scope, { id: `${++serial}`, label, kind, url,
			detail: new Headers(init?.headers).get('Range') ?? undefined,
			historyOnly: true, retryWhen,
			priority: kind === 'world' || kind === 'cameras' ? -10 : 0,
			maxAttempts: init?.method && init.method !== 'GET' ? 1 : maxAttempts,
			run: async (signal, requestId) => read(await responseOrThrow(url, signal, { ...init, headers: requestHeaders(url, init, requestId) }))
		}, init?.signal ?? undefined);
	};
}
function describeRequest(url: string): { kind: RequestKind; label: string } {
	if (url.includes('/map')) return { kind: 'map', label: 'OpenStreetMap (API / Overpass)' };
	if (url.includes('/labels')) return { kind: 'labels', label: 'Place and terrain names (API / Overpass)' };
	if (url.includes('/viewpoint')) return { kind: 'world', label: 'Viewpoint placement' };
	if (url.includes('/ortho')) return { kind: 'ortho', label: 'Orthophoto (ČÚZK, via earth)' };
	if (url.includes('/ground')) return { kind: 'terrain', label: 'Ground fit measurements' };
	if (url.includes('/terrain')) return { kind: 'terrain', label: 'Terrain coverage' };
	if (url.includes('/cameras')) return { kind: 'cameras', label: 'Camera poses' };
	if (url.includes('cloud') || url.includes('.laz')) return { kind: 'points', label: 'Point cloud' };
	return { kind: 'world', label: url.includes('/copc') ? 'Octree availability' : 'World metadata' };
}

/**
 * The request id goes only to this page's own origin: the workbench's API reads it, to put a read
 * beside its server log (world_requests.py). Another origin (earth, read straight from the public
 * app) never reads it, and a custom header there costs a CORS preflight for every distinct URL
 * (earth refused it outright: 400, every tile lost).
 */
export function requestHeaders(url: string, init: RequestInit | undefined, requestId: string): Headers {
	const headers = new Headers(init?.headers);
	if (sameOrigin(url)) headers.set('X-World-Request-Id', requestId);
	return headers;
}

/** a URL on this page's origin; without a page (tests, workers without one) only a relative URL is */
export function sameOrigin(url: string): boolean {
	const here = globalThis.location?.href;
	if (!here) return !/^[a-z][a-z0-9+.-]*:/i.test(url);
	try {
		return new URL(url, here).origin === new URL(here).origin;
	} catch {
		return false;
	}
}
