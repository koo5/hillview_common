import type { Copc } from 'copc';
import type { CopcChunk } from './copcSource';

export type DecodeInput = {
	compressed: Uint8Array;
	header: Copc['header'];
	eb: Copc['eb'];
	pointCount: number;
	stride?: number;
	hasViews: boolean;
	hasCloudTypes?: boolean;
};
export type DecodeRequest = { id: number; input: DecodeInput } | { cancel: number };
export type DecodeReply = { id: number; chunk: CopcChunk } | { id: number; error: string };

/**
 * HOW MANY BLOCKS DECODE AT ONCE (ea14 D, 2026-11-11). LAZ decompression is ~90 % of a block's decode (5.9 of 6.6 s
 * over 8.8 M rows of the world tree, investigations/ea14-world-load-2026-11-09/decode_bench.mjs), and one worker held
 * the stream at ~1.3 M rows/s: the ~1 M rows/s the viewer's telemetry showed in real browsers, with the network at
 * 80-110 MiB/s. Blocks are independent, so they decode side by side: half the cores, 1 to 4, leaving the rest to the
 * page, the GPU driver and the browser. Each worker's WASM heap grows to the largest block it decoded and keeps it
 * (~7-15 MB at 200,000 rows of 36 bytes), so a device that says it has under 8 GiB (navigator.deviceMemory, which
 * Chrome caps at 8; a phone says 2-4) runs at most two. A browser that says nothing is taken at its cores.
 */
export function decoderCount(cores: number | undefined = globalThis.navigator?.hardwareConcurrency,
	memoryGiB: number | undefined = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory): number {
	if (!Number.isFinite(cores) || !cores || cores < 1) return 1;
	const most = Number.isFinite(memoryGiB) && memoryGiB! < 8 ? 2 : 4;
	return Math.max(1, Math.min(most, Math.floor(cores / 2)));
}

type Slot = { worker: Worker; jobs: number };

/**
 * Up to `size` workers per source, made as the work needs them: a job goes to an idle worker, a new one only when
 * every worker is busy and fewer than `size` exist, else to the least busy. Each job's reply and cancel stay with the
 * worker that has it. Compressed and decoded buffers cross by ownership transfer.
 */
export class CopcDecoder {
	private slots: Slot[] = [];
	private nextId = 0;
	private closed = false;
	private pending = new Map<number, { slot: Slot; resolve: (chunk: CopcChunk) => void; reject: (error: unknown) => void }>();

	constructor(private readonly size: number = decoderCount()) {
		if (!Number.isInteger(size) || size < 1) throw new Error(`a COPC decoder needs at least one worker, not ${size}`);
	}

	/** how many workers exist now (made as the work needs them, up to `size`) */
	get workers(): number { return this.slots.length; }

	private slot(): Slot {
		const idle = this.slots.find(s => s.jobs === 0);
		if (idle) return idle;
		if (this.slots.length < this.size) {
			const worker = new Worker(new URL('./copcDecode.worker.ts', import.meta.url), { type: 'module' });
			worker.onmessage = ({ data }: MessageEvent<DecodeReply>) => {
				const job = this.pending.get(data.id);
				if (!job) return;
				this.pending.delete(data.id);
				job.slot.jobs--;
				if ('error' in data) job.reject(new Error(`COPC decode failed: ${data.error}`));
				else job.resolve(data.chunk);
			};
			worker.onerror = (event) => this.dispose(new Error(`COPC decoder worker failed: ${event.message}`));
			worker.onmessageerror = () => this.dispose(new Error('COPC decoder returned an unreadable message'));
			const made = { worker, jobs: 0 };
			this.slots.push(made);
			return made;
		}
		return this.slots.reduce((a, b) => (b.jobs < a.jobs ? b : a));
	}

	decode(input: DecodeInput, signal?: AbortSignal): Promise<CopcChunk> {
		signal?.throwIfAborted();
		if (this.closed) return Promise.reject(new DOMException('COPC decoder closed', 'AbortError'));
		const slot = this.slot();
		const id = ++this.nextId;
		return new Promise<CopcChunk>((resolve, reject) => {
			const cleanup = () => signal?.removeEventListener('abort', abort);
			const abort = () => {
				if (!this.pending.delete(id)) return;
				slot.jobs--;
				slot.worker.postMessage({ cancel: id } satisfies DecodeRequest);
				cleanup();
				reject(signal?.reason ?? new DOMException('COPC decode cancelled', 'AbortError'));
			};
			this.pending.set(id, {
				slot,
				resolve: chunk => { cleanup(); resolve(chunk); },
				reject: error => { cleanup(); reject(error); }
			});
			slot.jobs++;
			signal?.addEventListener('abort', abort, { once: true });
			try {
				slot.worker.postMessage({ id, input } satisfies DecodeRequest, [input.compressed.buffer as ArrayBuffer]);
			} catch (error) {
				this.pending.delete(id);
				slot.jobs--;
				cleanup();
				reject(error);
			}
		});
	}

	dispose(error: unknown = new DOMException('COPC decoder closed', 'AbortError')) {
		this.closed = true;
		for (const s of this.slots) s.worker.terminate();
		this.slots = [];
		const jobs = [...this.pending.values()];
		this.pending.clear();
		for (const job of jobs) job.reject(error);
	}
}
