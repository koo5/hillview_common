import type { CopcChunk } from './copcSource';

const bytes=(c:CopcChunk)=>c.positions.byteLength+c.colors.byteLength+(c.views?.byteLength??0)+(c.cloudTypes?.byteLength??0);
const copy=(c:CopcChunk):CopcChunk=>({positions:c.positions.slice(),colors:c.colors.slice(),views:c.views?.slice()??null,cloudTypes:c.cloudTypes?.slice()??null});

/** Decoded nodes belong to one immutable source. Each viewer receives its own arrays:
 * section filtering, placement and geometry centering all mutate them in place.
 */
export class CopcChunkCache {
	private entries=new Map<string,CopcChunk>();
	private size=0;
	constructor(readonly maxBytes=64*1024*1024){}
	get byteLength(){return this.size;}
	get(key:string):CopcChunk|undefined{
		const chunk=this.entries.get(key);
		if(!chunk)return;
		this.entries.delete(key);this.entries.set(key,chunk);
		return copy(chunk);
	}
	set(key:string,chunk:CopcChunk){
		const old=this.entries.get(key);
		if(old){this.size-=bytes(old);this.entries.delete(key);}
		const cost=bytes(chunk);
		if(cost>this.maxBytes)return;
		while(this.size+cost>this.maxBytes){
			const first=this.entries.keys().next().value!;
			this.size-=bytes(this.entries.get(first)!);this.entries.delete(first);
		}
		this.entries.set(key,copy(chunk));this.size+=cost;
	}
	clear(){this.entries.clear();this.size=0;}
}
