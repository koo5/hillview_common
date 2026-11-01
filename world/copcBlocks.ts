import type { CopcChunk, CopcNode, CopcSource } from './copcSource';
import { retryCopcRead } from './copcRange';
import type { WorldRequests } from './worldRequests';

/**
 * Read `nodes` of a tree through the shared request scheduler (one job a block, nearest first, three
 * attempts on a retryable range failure), handing each decoded block to `each` in order. The caller
 * decides what a block becomes: residency for a streamed world, a slab cut for a section.
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
		maxAttempts: 3, retryWhen: retryCopcRead,
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
