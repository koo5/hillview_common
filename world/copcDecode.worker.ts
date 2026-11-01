import { Las } from 'copc';
import { LazPerf } from 'laz-perf';
import lazPerfWasm from 'laz-perf/lib/laz-perf.wasm?url';
import type { DecodeInput, DecodeRequest, DecodeReply } from './copcDecoder';
import type { CopcChunk } from './copcSource';
import { DENSE_CLOUD } from './worldClouds';

// This module is only loaded in the worker: WASM compilation, LAZ decompression and
// packing xyz/RGB/view arrays never execute on the renderer's thread.
const scope = self as unknown as {
	onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null;
	postMessage: (reply: DecodeReply, transfer?: Transferable[]) => void;
};
let lazPerfOnce: Promise<Awaited<ReturnType<typeof LazPerf.create>>> | null = null;
const queued = new Map<number, DecodeInput>();
let running = false;
scope.onmessage = ({ data }) => {
	if ('cancel' in data) queued.delete(data.cancel);
	else queued.set(data.id, data.input);
	if (!running) void pump();
};
async function pump() {
	running = true;
	try {
		// Yield between blocks so cancellations of queued jobs can arrive.
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		const job = queued.entries().next().value;
		if (!job) return;
		const [id, input] = job;
		queued.delete(id);
		try {
			const chunk = await decode(input);
			const transfer = [chunk.positions.buffer, chunk.colors.buffer] as ArrayBuffer[];
			if (chunk.views) transfer.push(chunk.views.buffer as ArrayBuffer);
			if (chunk.cloudTypes) transfer.push(chunk.cloudTypes.buffer as ArrayBuffer);
			scope.postMessage({ id, chunk }, transfer);
		} catch (error) {
			scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
		}
	} finally {
		running = false;
		if (queued.size) void pump();
	}
}
async function decode(input: DecodeInput): Promise<CopcChunk> {
	lazPerfOnce ??= LazPerf.create({ locateFile: () => lazPerfWasm });
	const buffer = await Las.PointData.decompressChunk(input.compressed, {
		pointCount: input.pointCount,
		pointDataRecordFormat: input.header.pointDataRecordFormat,
		pointDataRecordLength: input.header.pointDataRecordLength
	}, await lazPerfOnce);
	const view = Las.View.create(buffer, input.header, input.eb);
	// a strided node is read in full and kept in part: LAZ is compressed as a chunked stream,
	// so there is no cheaper way to reach the n-th point than to decode the ones before it
	const step = Math.max(1, Math.floor(input.stride ?? 1));
	const n = Math.ceil(view.pointCount / step);
	const gx = view.getter('X'), gy = view.getter('Y'), gz = view.getter('Z');
	const positions = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		positions[i * 3] = gx(i * step);
		positions[i * 3 + 1] = gy(i * step);
		positions[i * 3 + 2] = gz(i * step);
	}

	// LAS stores RGB in uint16 fields, but PDAL forwards a PLY's uchar channels as the
	// same 0-255 numbers rather than rescaling them. Both conventions exist in the wild,
	// so decide from the data instead of assuming: >255 anywhere means a 16-bit range.
	const colors = new Uint8Array(n * 3);
	const has = 'Red' in view.dimensions;
	if (has) {
		const gr = view.getter('Red'), gg = view.getter('Green'), gb = view.getter('Blue');
		let max = 0;
		for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 512))) {
			max = Math.max(max, gr(i * step), gg(i * step), gb(i * step));
		}
		const shift = max > 255 ? 8 : 0;
		for (let i = 0; i < n; i++) {
			colors[i * 3] = gr(i * step) >> shift;
			colors[i * 3 + 1] = gg(i * step) >> shift;
			colors[i * 3 + 2] = gb(i * step) >> shift;
		}
	} else {
		colors.fill(180);
	}

	// only when the RUN has them: see hasViews above -- an all-zero PointSourceId would
	// otherwise read as "every point came from camera 0" and quietly break isolate
	let views: Uint16Array | null = null;
	if (input.hasViews && 'PointSourceId' in view.dimensions) {
		const gv = view.getter('PointSourceId');
		views = new Uint16Array(n);
		for (let i = 0; i < n; i++) views[i] = gv(i * step);
	}
	let cloudTypes: Uint8Array | null = null;
	if (input.hasCloudTypes) {
		if (!('UserData' in view.dimensions)) throw new Error('World octree has no cloud-source tags; rebuild it');
		const getType = view.getter('UserData');
		cloudTypes = new Uint8Array(n);
		for (let i=0;i<n;i++) {
			const kind=getType(i*step);
			if (kind!==DENSE_CLOUD) throw new Error('World octree contains non-dense points; rebuild the dense-only browser world');
			cloudTypes[i]=kind;
		}
	}
	return { positions, colors, views, cloudTypes };
}
