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

/** One lazy worker per source. Compressed and decoded buffers cross by ownership transfer. */
export class CopcDecoder {
	private worker: Worker | null = null;
	private nextId = 0;
	private closed = false;
	private pending = new Map<number, { resolve: (chunk: CopcChunk) => void; reject: (error: unknown) => void }>();

	decode(input: DecodeInput, signal?: AbortSignal): Promise<CopcChunk> {
		signal?.throwIfAborted();
		if (this.closed) return Promise.reject(new DOMException('COPC decoder closed', 'AbortError'));
		if (!this.worker) {
			this.worker = new Worker(new URL('./copcDecode.worker.ts', import.meta.url), { type: 'module' });
			this.worker.onmessage = ({ data }: MessageEvent<DecodeReply>) => {
				const job = this.pending.get(data.id);
				if (!job) return;
				this.pending.delete(data.id);
				if ('error' in data) job.reject(new Error(`COPC decode failed: ${data.error}`));
				else job.resolve(data.chunk);
			};
			this.worker.onerror = (event) => this.dispose(new Error(`COPC decoder worker failed: ${event.message}`));
			this.worker.onmessageerror = () => this.dispose(new Error('COPC decoder returned an unreadable message'));
		}
		const worker = this.worker;
		const id = ++this.nextId;
		return new Promise<CopcChunk>((resolve, reject) => {
			const cleanup = () => signal?.removeEventListener('abort', abort);
			const abort = () => {
				this.pending.delete(id);
				worker.postMessage({ cancel: id } satisfies DecodeRequest);
				cleanup();
				reject(signal?.reason ?? new DOMException('COPC decode cancelled', 'AbortError'));
			};
			this.pending.set(id, {
				resolve: chunk => { cleanup(); resolve(chunk); },
				reject: error => { cleanup(); reject(error); }
			});
			signal?.addEventListener('abort', abort, { once: true });
			try {
				worker.postMessage({ id, input } satisfies DecodeRequest, [input.compressed.buffer as ArrayBuffer]);
			} catch (error) {
				this.pending.delete(id);
				cleanup();
				reject(error);
			}
		});
	}

	dispose(error: unknown = new DOMException('COPC decoder closed', 'AbortError')) {
		this.closed = true;
		this.worker?.terminate();
		this.worker = null;
		for (const job of this.pending.values()) job.reject(error);
		this.pending.clear();
	}
}
