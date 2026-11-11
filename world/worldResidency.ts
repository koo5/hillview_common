import type {CopcChunk, CopcNode} from './copcSource';
import {DENSE_CLOUD, SPARSE_CLOUD} from './worldClouds';

const MiB=1024*1024;
const chunkBytes=(c:CopcChunk)=>c.positions.byteLength+c.colors.byteLength+
	(c.views?.byteLength??0)+(c.cloudTypes?.byteLength??0)+(c.linear?.byteLength??0);

/**
 * How a viewer that draws something other than the decoded rows keeps them (ea14, RECON-UI's review of A0). `rows`
 * turns a block's kept rows into the form the viewer draws (placed positions, linear colours, ...). The residency
 * then holds and charges THAT form instead of the decoded one, at `bytesPerRow` when it makes room. So the budget
 * bounds what is really held and no third copy lives outside it. It may drop rows (a placement's own refusals);
 * never add them.
 */
export type WorldPlacement = {
	bytesPerRow: number;
	rows: (chunk: CopcChunk, yieldWork: () => Promise<void>) => Promise<CopcChunk>;
};

/** One viewer's full-depth nodes, charged after filtering by native source kind.
 * Two bounds: maxGeometryBytes for the drawn geometry (float32 XYZ + linear float32 RGB, 24 bytes/point), and
 * maxDecodedBytes for what the residency itself holds: the decoded rows (16 bytes/row, 18 with source ids), or a
 * WorldPlacement's drawn form at its own bytesPerRow. The GPU bound is a residency policy, not a claim about free
 * physical VRAM.
 *
 * A VIEW CHANGE KEEPS WHAT IS LOADED (ea14 C, 2026-11-09). reconcile used to drop every block outside the new view's
 * plan at once, so turning the camera emptied the screen and turning back fetched it all again (the operator: "the
 * viewer drops points when i turn around"). A block the new plan does not want is now RETAINED: still resident,
 * still drawn (blocks/resident list it after the plan's), still charged to the budget. It leaves only when a wanted
 * block needs its room: the finest retained first, then the least recently wanted, then (as before) lower-ranked
 * wanted blocks. A sampled (blocked) block, a mode change and a hidden-source change still drop it.
 */
export class WorldResidency {
	private chunks=new Map<string,CopcChunk>();
	private nodes=new Map<string,CopcNode>();
	private wantedAt=new Map<string,number>();
	private wanted=new Set<string>();
	private eligible:CopcNode[]=[];
	private blocked=new Set<string>();
	private mode:'dense'|'all'='dense';
	private hidden=new Set<number>();
	private hiddenKey='';
	private points=0;
	private decodedBytes=0;
	private generation=0;
	constructor(readonly maxGeometryBytes=64*MiB, readonly maxDecodedBytes=64*MiB){
		if(!Number.isSafeInteger(maxGeometryBytes)||maxGeometryBytes<24||
			!Number.isSafeInteger(maxDecodedBytes)||maxDecodedBytes<16)
			throw new Error('World residency requires explicit positive byte bounds');
	}

	private drop(key:string){
		const chunk=this.chunks.get(key);if(!chunk)return;
		this.points-=chunk.positions.length/3;this.decodedBytes-=chunkBytes(chunk);
		this.chunks.delete(key);this.nodes.delete(key);this.wantedAt.delete(key);this.blocked.delete(key);
	}

	/** Retained keys in the order they give up their room: the deepest first, then the least recently wanted. */
	private retainedOrder():string[]{
		return [...this.chunks.keys()].filter(k=>!this.wanted.has(k)).sort((a,b)=>
			(this.nodes.get(b)?.depth??0)-(this.nodes.get(a)?.depth??0)||(this.wantedAt.get(a)??0)-(this.wantedAt.get(b)??0));
	}

	reconcile(nodes:CopcNode[], mode:'dense'|'all', hiddenSources:number[]=[]){
		this.generation++;
		const hidden=[...new Set(hiddenSources)].sort((a,b)=>a-b),key=hidden.join(',');
		if(mode!==this.mode||key!==this.hiddenKey){this.clear();this.mode=mode;this.hiddenKey=key;this.hidden=new Set(hidden);}
		this.eligible=nodes;
		this.wanted=new Set(nodes.map(n=>n.key));
		for(const k of this.wanted)if(this.chunks.has(k))this.wantedAt.set(k,this.generation);
		// A new view can promote a sampled node to full detail after other nodes leave.
		for(const k of [...this.blocked])this.drop(k);
		this.blocked.clear();
	}

	nextBatch(maxNodes=3, rawPoints=400000, group:(node:CopcNode)=>unknown=()=>0):CopcNode[]{
		// Stop rather than fetching the rest of a 100M+ tree after residency fills.
		if(this.blocked.size)return [];
		// Do not prefetch a large tail that cannot fit after the nearer prefix.
		// One oversized first node is still read whole so it can be sampled;
		// already resident lower-ranked rows remain reclaimable by accept().
		rawPoints=Math.min(rawPoints,Math.max(1,Math.floor(this.maxGeometryBytes/24)-this.priorityPoints));
		const batch:CopcNode[]=[];
		let count=0,firstGroup:unknown;
		for(const node of this.eligible){
			if(this.chunks.has(node.key)||this.blocked.has(node.key))continue;
			const nodeGroup=group(node);
			if(batch.length&&(batch.length>=maxNodes||count+node.pointCount>rawPoints||nodeGroup!==firstGroup))break;
			firstGroup=nodeGroup;batch.push(node);count+=node.pointCount;
		}
		return batch;
	}

	async accept(node:CopcNode, raw:CopcChunk, yieldWork:()=>Promise<void>=async()=>{}, placement?:WorldPlacement):Promise<boolean>{
		if(placement&&(!Number.isSafeInteger(placement.bytesPerRow)||placement.bytesPerRow<1))
			throw new Error('A world placement must say how many bytes it holds per row');
		if(this.chunks.has(node.key))return true;
		if(!this.eligible.some(n=>n.key===node.key))return false;
		const generation=this.generation,mode=this.mode,hidden=this.hidden;
		const n=raw.positions.length/3,types=raw.cloudTypes??null;
		// THE TAGS ARE READ ONLY TO KEEP THE DENSE ROWS: a merged world's tree carries them, a run's tree is one cloud and
		// has none (RECON-UI's ui09). Mode 'all' keeps every row, so it takes a block without tags as it is; 'dense'
		// cannot tell its rows apart without them and refuses (EARTH, 2026-11-11).
		if(!types&&mode==='dense')throw new Error('Invalid tagged world point block: dense rows need their cloud tags');
		if(!Number.isInteger(n)||(types&&types.length!==n)||raw.colors.length!==n*3||
			(raw.views&&raw.views.length!==n))throw new Error('Invalid tagged world point block');
		if(hidden.size&&!raw.views)throw new Error('World source indices missing for removed-run filtering');
		const valid=(i:number)=>{
			const p=raw.positions,x=p[i*3],y=p[i*3+1],z=p[i*3+2];
			return (!hidden.size||!hidden.has(raw.views![i]))&&Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z)&&
				Math.abs(x)<=1e6&&Math.abs(y)<=1e6&&Math.abs(z)<=1e6;
		};
		let count=0;
		for(let i=0;i<n;i++){
			if(i%16384===0)await yieldWork();
			if(types&&types[i]!==DENSE_CLOUD&&types[i]!==SPARSE_CLOUD)throw new Error('Unknown world cloud-source tag');
			if((mode==='all'||types![i]===DENSE_CLOUD)&&valid(i))count++;
		}
		if(generation!==this.generation)return false;
		const bytesPerRow=placement?placement.bytesPerRow:16+(raw.views?2:0);
		// A new view's near blocks must be able to displace lower-priority
		// residency. Otherwise ranking requests cannot change a full far view.
		const target=Math.min(count,Math.floor(this.maxGeometryBytes/24),Math.floor(this.maxDecodedBytes/bytesPerRow));
		const roomy=()=>Math.floor(this.maxGeometryBytes/24)-this.points>=target&&
			Math.floor((this.maxDecodedBytes-this.decodedBytes)/bytesPerRow)>=target;
		// retained blocks (no longer in the plan) give up their room first, then lower-ranked wanted ones
		for(const key of this.retainedOrder()){if(roomy())break;this.drop(key);}
		const rank=this.eligible.findIndex(n=>n.key===node.key);
		for(let i=this.eligible.length-1;i>rank;i--){
			if(roomy())break;
			this.drop(this.eligible[i].key);
		}
		const keepCount=Math.min(count,Math.floor(this.maxGeometryBytes/24)-this.points,
			Math.floor((this.maxDecodedBytes-this.decodedBytes)/bytesPerRow));
		if(keepCount<count)this.blocked.add(node.key);
		if(keepCount<=0&&count>0)return false;
		let chunk=raw;
		if(keepCount!==n){
			chunk={positions:new Float32Array(keepCount*3),colors:new Uint8Array(keepCount*3),
				views:raw.views?new Uint16Array(keepCount):null,cloudTypes:types?new Uint8Array(keepCount):null};
			let k=0,rank=0;
			for(let i=0;i<n;i++){
				if(i%16384===0)await yieldWork();
				if((mode==='dense'&&types![i]!==DENSE_CLOUD)||!valid(i))continue;
				// Evenly sample only the rows actually being displayed, after source filtering.
				if(rank++!==Math.floor(k*count/keepCount))continue;
				chunk.positions.set(raw.positions.subarray(i*3,i*3+3),k*3);
				chunk.colors.set(raw.colors.subarray(i*3,i*3+3),k*3);
				if(chunk.views)chunk.views[k]=raw.views![i];
				if(types)chunk.cloudTypes![k]=types[i];
				k++;
			}
		}
		if(generation!==this.generation)return false;
		if(placement){
			chunk=await placement.rows(chunk,yieldWork);
			if(generation!==this.generation)return false;
			const m=chunk.positions.length/3;
			if(!Number.isInteger(m)||m>keepCount||chunk.colors.length!==m*3||(chunk.views&&chunk.views.length!==m)||
				(chunk.linear&&chunk.linear.length!==m*3))throw new Error('A world placement may drop rows, never add them');
		}
		this.chunks.set(node.key,chunk);this.nodes.set(node.key,node);this.wantedAt.set(node.key,this.generation);
		this.points+=chunk.positions.length/3;this.decodedBytes+=chunkBytes(chunk);
		return true;
	}

	/** Rows already present in the nearest continuous prefix, not old far residency. */
	get priorityPoints(){
		let points=0;
		for(const node of this.eligible){const c=this.chunks.get(node.key);if(!c)break;points+=c.positions.length/3;}
		return points;
	}
	/** The plan's resident nodes, in its order: what THIS view has loaded, without the blocks kept from earlier views.
	 * A reader that speaks of this view (how deep its detail goes) reads these, not `resident` (RECON-UI's world line,
	 * EARTH's review: after a close look and a turn away, a retained deep block is not this view's detail). */
	get planned(){return this.eligible.filter(n=>this.chunks.has(n.key));}
	/** Every resident node: the plan's, in its order, then the retained ones, the most recently wanted first. */
	get resident(){
		const retained=[...this.chunks.keys()].filter(k=>!this.wanted.has(k))
			.sort((a,b)=>(this.wantedAt.get(b)??0)-(this.wantedAt.get(a)??0)).map(k=>this.nodes.get(k)!);
		return [...this.planned,...retained];
	}
	get blocks(){return this.resident.map(n=>this.chunks.get(n.key)!);}
	get summary(){
		const pending=this.eligible.filter(n=>!this.chunks.has(n.key)&&!this.blocked.has(n.key)).length;
		const retained=[...this.chunks.keys()].filter(k=>!this.wanted.has(k)).length;
		// nodes: the plan's resident blocks, so "nodes of eligible" says how far this view is; retained: those kept from
		// earlier views (drawn and charged too; points and the bytes count them)
		return {points:this.points,decodedBytes:this.decodedBytes,geometryBytes:this.points*24,
			nodes:this.chunks.size-retained,eligible:this.eligible.length,pending,limited:this.blocked.size,retained,
			complete:pending===0&&this.blocked.size===0};
	}
	clear(){
		this.generation++;this.chunks.clear();this.nodes.clear();this.wantedAt.clear();this.wanted.clear();
		this.blocked.clear();this.eligible=[];this.points=0;this.decodedBytes=0;
	}
}
