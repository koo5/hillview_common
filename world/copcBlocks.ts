import type { CopcChunk, CopcNode, CopcSource } from './copcSource';
import { retryCopcRead } from './copcRange';
import type { WorldRequests } from './worldRequests';

/**
 * How long one block's read (range + decode) may take before it is given up and read again (ea14, 2026-11-10). The
 * scheduler's default is 180 s, and blocks are handed over in order, so one hung request held its whole batch, and the
 * view's refinement, for three minutes ("loads at like 1MB/s"). A block takes 20-80 ms on the bench's own link; this
 * allows 8 s plus 0.1 ms a point, i.e. links down to ~100 KB/s at the trees' ~10 compressed bytes a point or fewer.
 */
export function blockTimeoutMs(node: Pick<CopcNode, 'pointCount'>): number {
	return 8000 + Math.ceil(node.pointCount / 10);
}

/**
 * Read `nodes` of a tree through the shared request scheduler (one job a block, nearest first, three
 * attempts on a retryable range failure, each bounded by blockTimeoutMs), handing each decoded block to `each` in
 * order. The caller decides what a block becomes: residency for a streamed world, a slab cut for a section.
 */
export async function readBlocks(source: CopcSource, nodes: CopcNode[], opts: {
	url: string; requests: WorldRequests | null; scope: string; signal: AbortSignal;
	each: (index: number, node: CopcNode, chunk: CopcChunk) => Promise<void>;
	/** before each block is awaited: a progress line, a yield to the page */
	before?: (index: number, node: CopcNode) => Promise<void> | void;
}): Promise<void> {
	const { url, requests, scope, signal, each, before } = opts;
	const jobs = nodes.map((node, priority) => ({
		id: `${url}|${node.key}|${node.stride ?? 1}`, url, kind: 'points' as const, priority,
		maxAttempts: 3, retryWhen: retryCopcRead, timeoutMs: blockTimeoutMs(node),
		label: `Point block ${node.key}${node.stride ? ` · 1/${node.stride} samples` : ''}`,
		run: (s: AbortSignal) => source.load(node, s)
	}));
	requests?.reconcile(scope, jobs);
	const reads = requests ? jobs.map(job => requests.request(scope, job, signal)) : null;
	for (const read of reads ?? []) void read.catch(() => {});
	for (const [index, node] of nodes.entries()) {
		await before?.(index, node);
		const chunk = reads ? await reads[index] : await source.load(node);
		await each(index, node, chunk);
	}
}
