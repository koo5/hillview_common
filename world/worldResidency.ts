import type {CopcChunk, CopcNode} from './copcSource';
import {DENSE_CLOUD, SPARSE_CLOUD} from './worldClouds';

const MiB=1024*1024;
const chunkBytes=(c:CopcChunk)=>c.positions.byteLength+c.colors.byteLength+
	(c.views?.byteLength??0)+(c.cloudTypes?.byteLength??0);

/** One viewer's full-depth nodes, charged after filtering by native source kind.
 * Geometry currently uses float32 XYZ + linear float32 RGB (24 bytes/point).
 * The GPU bound is a residency policy, not a claim about free physical VRAM.
 */
export class WorldResidency {
	private chunks=new Map<string,CopcChunk>();
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

	reconcile(nodes:CopcNode[], mode:'dense'|'all', hiddenSources:number[]=[]){
		this.generation++;
		const hidden=[...new Set(hiddenSources)].sort((a,b)=>a-b),key=hidden.join(',');
		if(mode!==this.mode||key!==this.hiddenKey){this.clear();this.mode=mode;this.hiddenKey=key;this.hidden=new Set(hidden);}
		this.eligible=nodes;
		const wanted=new Set(nodes.map(n=>n.key));
		for(const [key,chunk] of this.chunks){
			if(wanted.has(key))continue;
			this.points-=chunk.positions.length/3;this.decodedBytes-=chunkBytes(chunk);this.chunks.delete(key);
		}
		// A new view can promote a sampled node to full detail after other nodes leave.
		for(const key of this.blocked){
			const chunk=this.chunks.get(key);if(!chunk)continue;
			this.points-=chunk.positions.length/3;this.decodedBytes-=chunkBytes(chunk);this.chunks.delete(key);
		}
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

	async accept(node:CopcNode, raw:CopcChunk, yieldWork:()=>Promise<void>=async()=>{}):Promise<boolean>{
		if(this.chunks.has(node.key))return true;
		if(!this.eligible.some(n=>n.key===node.key))return false;
		const generation=this.generation,mode=this.mode,hidden=this.hidden;
		const n=raw.positions.length/3,types=raw.cloudTypes;
		if(!Number.isInteger(n)||!types||types.length!==n||raw.colors.length!==n*3||
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
			if(types[i]!==DENSE_CLOUD&&types[i]!==SPARSE_CLOUD)throw new Error('Unknown world cloud-source tag');
			if((mode==='all'||types[i]===DENSE_CLOUD)&&valid(i))count++;
		}
		if(generation!==this.generation)return false;
		const bytesPerRow=16+(raw.views?2:0);
		// A new view's near blocks must be able to displace lower-priority
		// residency. Otherwise ranking requests cannot change a full far view.
		const target=Math.min(count,Math.floor(this.maxGeometryBytes/24),Math.floor(this.maxDecodedBytes/bytesPerRow));
		const rank=this.eligible.findIndex(n=>n.key===node.key);
		for(let i=this.eligible.length-1;i>rank;i--){
			if(Math.floor(this.maxGeometryBytes/24)-this.points>=target&&
				Math.floor((this.maxDecodedBytes-this.decodedBytes)/bytesPerRow)>=target)break;
			const key=this.eligible[i].key,chunk=this.chunks.get(key);if(!chunk)continue;
			this.points-=chunk.positions.length/3;this.decodedBytes-=chunkBytes(chunk);
			this.chunks.delete(key);this.blocked.delete(key);
		}
		const keepCount=Math.min(count,Math.floor(this.maxGeometryBytes/24)-this.points,
			Math.floor((this.maxDecodedBytes-this.decodedBytes)/bytesPerRow));
		if(keepCount<count)this.blocked.add(node.key);
		if(keepCount<=0&&count>0)return false;
		let chunk=raw;
		if(keepCount!==n){
			chunk={positions:new Float32Array(keepCount*3),colors:new Uint8Array(keepCount*3),
				views:raw.views?new Uint16Array(keepCount):null,cloudTypes:new Uint8Array(keepCount)};
			let k=0,rank=0;
			for(let i=0;i<n;i++){
				if(i%16384===0)await yieldWork();
				if((mode==='dense'&&types[i]!==DENSE_CLOUD)||!valid(i))continue;
				// Evenly sample only the rows actually being displayed, after source filtering.
				if(rank++!==Math.floor(k*count/keepCount))continue;
				chunk.positions.set(raw.positions.subarray(i*3,i*3+3),k*3);
				chunk.colors.set(raw.colors.subarray(i*3,i*3+3),k*3);
				if(chunk.views)chunk.views[k]=raw.views![i];
				chunk.cloudTypes![k]=types[i];k++;
			}
		}
		if(generation!==this.generation)return false;
		this.chunks.set(node.key,chunk);this.points+=keepCount;this.decodedBytes+=chunkBytes(chunk);
		return true;
	}

	/** Rows already present in the nearest continuous prefix, not old far residency. */
	get priorityPoints(){
		let points=0;
		for(const node of this.eligible){const c=this.chunks.get(node.key);if(!c)break;points+=c.positions.length/3;}
		return points;
	}
	get resident(){return this.eligible.filter(n=>this.chunks.has(n.key));}
	get blocks(){return this.resident.map(n=>this.chunks.get(n.key)!);}
	get summary(){
		const pending=this.eligible.filter(n=>!this.chunks.has(n.key)&&!this.blocked.has(n.key)).length;
		return {points:this.points,decodedBytes:this.decodedBytes,geometryBytes:this.points*24,
			nodes:this.chunks.size,eligible:this.eligible.length,pending,limited:this.blocked.size,
			complete:pending===0&&this.blocked.size===0};
	}
	clear(){this.generation++;this.chunks.clear();this.blocked.clear();this.eligible=[];this.points=0;this.decodedBytes=0;}
}
