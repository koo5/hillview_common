import {expect,test} from 'vitest';
import {WorldResidency,type WorldPlacement} from './worldResidency';
import type {CopcNode} from './copcSource';
const node=(key:string,points=3):CopcNode=>({key,depth:0,pointCount:points,bounds:[0,0,0,1,1,1]});
const chunk=(types:number[])=>({positions:new Float32Array(types.flatMap((_,i)=>[i+1,i+2,i+3])),
	colors:new Uint8Array(types.flatMap(()=>[20,30,40])),cloudTypes:new Uint8Array(types),views:null});

test('dense residency counts the real filtered rows and keeps foliage-only blocks as empty ones',async()=>{
	const r=new WorldResidency(48,32),a=node('a'),b=node('b');r.reconcile([a,b],'dense');
	const raw=chunk([1,3,1]);expect(await r.accept(a,raw)).toBe(true);
	expect(await r.accept(b,chunk([3,3,3]))).toBe(true);
	expect(r.summary).toMatchObject({points:2,geometryBytes:48,decodedBytes:32,nodes:2,complete:true});
	expect([...r.blocks[0].positions]).toEqual([1,2,3,3,4,5]);
	expect([...raw.cloudTypes]).toEqual([1,3,1]);
	expect(r.blocks[1].positions.length).toBe(0);
});

test('bounded batches progress through deep nodes, deduplicate and visibly stop at memory limit',async()=>{
	const r=new WorldResidency(96,64),nodes=Array.from({length:5},(_,i)=>({...node(String(i),2),depth:i}));
	r.reconcile(nodes,'all');expect(r.nextBatch(3,3).map(n=>n.key)).toEqual(['0']);
	await r.accept(nodes[0],chunk([1,3]));await r.accept(nodes[0],chunk([1,3]));
	expect(r.summary.points).toBe(2);expect(r.nextBatch(3,4).map(n=>n.key)).toEqual(['1']);
	await r.accept(nodes[1],chunk([1,3]));expect(await r.accept(nodes[2],chunk([1,3]))).toBe(false);
	await r.accept(nodes[3],chunk([1,3]));await r.accept(nodes[4],chunk([1,3]));
	expect(r.summary).toMatchObject({nodes:2,points:4,pending:0,limited:3,complete:false});
	expect(r.nextBatch()).toEqual([]);
});

test('a view change keeps what is loaded until a wanted block needs its room; modes never mix',async()=>{
	const r=new WorldResidency(48,32),a=node('a',2),b={...node('b',2),depth:12};
	r.reconcile([a,b],'dense');await r.accept(a,chunk([1,1]));await r.accept(b,chunk([1,1]));
	// a is retained (still drawn); the sampled b is dropped so it can come back at full detail
	r.reconcile([b],'dense');expect(r.summary).toMatchObject({points:2,retained:1});expect(r.blocks.length).toBe(1);
	expect(r.nextBatch()).toEqual([b]);
	await r.accept(b,chunk([1,1]));expect(r.summary).toMatchObject({complete:true,retained:0,points:2});
	expect(r.resident.map(n=>n.key)).toEqual(['b']);
	r.reconcile([b],'all');expect(r.summary.nodes).toBe(0);expect(r.nextBatch()).toEqual([b]);
	await r.accept(b,chunk([1,3]));expect([...r.blocks[0].cloudTypes!]).toEqual([1,3]);
	r.clear();expect(r.summary.points).toBe(0);
});

test('turning away and back keeps what was loaded: retained blocks are drawn and need no fetch (ea14 C)',async()=>{
	const r=new WorldResidency(24*10,16*10),a=node('a',2),b=node('b',2),c=node('c',2);
	r.reconcile([a,b],'dense');await r.accept(a,chunk([1,1]));await r.accept(b,chunk([1,1]));
	r.reconcile([c],'dense');
	expect(r.resident.map(n=>n.key)).toEqual(['a','b']);   // still drawn while c loads
	expect(r.nextBatch()).toEqual([c]);await r.accept(c,chunk([1,1]));
	expect(r.resident.map(n=>n.key)).toEqual(['c','a','b']);
	// nodes are the plan's (c), retained the earlier views' (a, b): "1 of 1 blocks, 2 kept"
	expect(r.summary).toMatchObject({points:6,nodes:1,eligible:1,retained:2,complete:true});
	r.reconcile([a,b],'dense');
	expect(r.nextBatch()).toEqual([]);   // nothing to fetch again: both are resident
	expect(r.summary).toMatchObject({pending:0,retained:1,complete:true});
	expect(r.resident.map(n=>n.key)).toEqual(['a','b','c']);
});

test('planned is this view\'s resident blocks: a deep block kept from a view turned away from is not among them',async()=>{
	const r=new WorldResidency(24*10,16*10),deep={...node('deep',2),depth:9},coarse={...node('coarse',2),depth:5};
	r.reconcile([deep],'dense');await r.accept(deep,chunk([1,1]));
	r.reconcile([coarse],'dense');await r.accept(coarse,chunk([1,1]));
	expect(r.resident.map(n=>n.key)).toEqual(['coarse','deep']);   // deep is still drawn (retained)
	expect(r.planned.map(n=>n.key)).toEqual(['coarse']);
	expect(Math.max(...r.planned.map(n=>n.depth))).toBe(5);         // this view's detail ends at level 5, not 9
	r.reconcile([deep,coarse],'dense');
	expect(r.planned.map(n=>n.key)).toEqual(['deep','coarse']);     // wanted again, in the plan's order
});

test('a wanted block takes its room from the finest retained block first (ea14 C)',async()=>{
	const r=new WorldResidency(24*4,16*4);
	const coarse={...node('coarse',2),depth:1},fine={...node('fine',2),depth:5},next={...node('next',2),depth:3};
	r.reconcile([coarse,fine],'dense');await r.accept(coarse,chunk([1,1]));await r.accept(fine,chunk([1,1]));
	r.reconcile([next],'dense');expect(await r.accept(next,chunk([1,1]))).toBe(true);
	// four rows of room: the fine block went for the new one; the coarse one stays, drawn
	expect(r.resident.map(n=>n.key)).toEqual(['next','coarse']);
	expect(r.summary).toMatchObject({points:4,retained:1,limited:0});
});

test('among retained blocks of one depth, the least recently wanted gives up its room first (ea14 C)',async()=>{
	const r=new WorldResidency(24*4,16*4),x=node('x',2),y=node('y',2),z=node('z',2);
	r.reconcile([x],'dense');await r.accept(x,chunk([1,1]));
	r.reconcile([y],'dense');await r.accept(y,chunk([1,1]));
	r.reconcile([z],'dense');await r.accept(z,chunk([1,1]));
	expect(r.resident.map(n=>n.key)).toEqual(['z','y']);
	// wanted again, y counts as recent: the next newcomer takes z's room, not y's
	r.reconcile([y],'dense');r.reconcile([x],'dense');await r.accept(x,chunk([1,1]));
	expect(r.resident.map(n=>n.key)).toEqual(['x','y']);
});

test('a placement is what the residency holds and charges; it may drop rows but never add them (ea14)',async()=>{
	const r=new WorldResidency(24*10,30*4),a=node('a',4),b=node('b',2);
	const place=(drop=0):WorldPlacement=>({bytesPerRow:30,rows:async(c)=>{const m=c.positions.length/3-drop;
		return {positions:c.positions.slice(0,m*3).map(v=>v+100),colors:c.colors.slice(0,m*3),views:c.views?.slice(0,m)??null,
			cloudTypes:c.cloudTypes?.slice(0,m)??null,linear:new Float32Array(m*3)};}});
	r.reconcile([a,b],'dense');
	expect(await r.accept(a,chunk([1,1,1,1]),undefined,place(1))).toBe(true);
	expect([...r.blocks[0].positions.slice(0,3)]).toEqual([101,102,103]);
	// three placed rows: positions 36 + colours 9 + types 3 + linear 36 bytes
	expect(r.summary).toMatchObject({points:3,decodedBytes:84});
	// room is measured at the placement's 30 B/row: one of b's two rows fits beside a's three
	expect(await r.accept(b,chunk([1,1]),undefined,place())).toBe(true);
	expect(r.summary).toMatchObject({points:4,decodedBytes:112,limited:1});
	const c=node('c',1),add:WorldPlacement={bytesPerRow:30,rows:async(x)=>({...x,positions:new Float32Array(x.positions.length+3)})};
	r.reconcile([c],'dense');
	await expect(r.accept(c,chunk([1]),undefined,add)).rejects.toThrow('never add');
	await expect(r.accept(c,chunk([1]),undefined,{...add,bytesPerRow:0})).rejects.toThrow('bytes it holds per row');
});

test('unknown or missing source tags fail before publishing a block',async()=>{
	const r=new WorldResidency(),a=node('a');r.reconcile([a],'dense');
	await expect(r.accept(a,chunk([1,0,3]))).rejects.toThrow('Unknown');
	await expect(r.accept(a,chunk([1,2,1]))).rejects.toThrow('Unknown');     // the retired sparse tag
	await expect(r.accept(a,{...chunk([1]),cloudTypes:undefined})).rejects.toThrow('dense rows need their cloud tags');
	await expect(r.accept(a,{...chunk([1,1]),cloudTypes:new Uint8Array([1])})).rejects.toThrow('Invalid');
	expect(r.summary.nodes).toBe(0);
});

test('a tree of one cloud (a run\'s) is held untagged in mode all, whole or sampled', async()=>{
	const untagged=(n:number)=>({...chunk(Array(n).fill(1)),cloudTypes:null});
	const whole=new WorldResidency(),a=node('a',2);whole.reconcile([a],'all');
	expect(await whole.accept(a,untagged(2))).toBe(true);
	expect(whole.blocks[0].cloudTypes).toBeNull();
	expect(whole.summary).toMatchObject({points:2,decodedBytes:30,complete:true});
	// one block past the room (48 bytes of geometry: 2 rows of its 4) is sampled, and stays untagged
	const small=new WorldResidency(48,64),b=node('b',4);small.reconcile([b],'all');
	expect(await small.accept(b,untagged(4))).toBe(true);
	expect([small.blocks[0].positions.length/3,small.blocks[0].cloudTypes,small.summary.limited]).toEqual([2,null,1]);
});

test('a view or source change during yielded filtering cannot publish stale chunks',async()=>{
 const r=new WorldResidency(),a=node('a'),b=node('b');r.reconcile([a],'dense');
 let changed=false;
 expect(await r.accept(a,chunk([1,3,1]),async()=>{
  if(!changed){changed=true;r.reconcile([b],'all');}
 })).toBe(false);
 expect(r.summary).toMatchObject({points:0,nodes:0,pending:1});
 expect(r.nextBatch()).toEqual([b]);
});

test('a filled residency budget stops downloads rather than reading and rejecting the rest of the tree',async()=>{
 const r=new WorldResidency(48,32),nodes=Array.from({length:10000},(_,i)=>node(String(i),2));
 r.reconcile(nodes,'dense');await r.accept(nodes[0],chunk([1,1]));
 expect(await r.accept(nodes[1],chunk([1,1]))).toBe(false);
 expect(r.summary).toMatchObject({points:2,pending:9998,limited:1,complete:false});
 expect(r.nextBatch()).toEqual([]);
 r.reconcile(nodes.slice(1,2),'dense');expect(r.nextBatch()).toEqual([nodes[1]]);
});

test('an oversized visible node uses the remaining drawn-row budget and promotes after moving',async()=>{
 const r=new WorldResidency(96,64),a=node('a',2),b=node('b',6);
 r.reconcile([a,b],'dense');await r.accept(a,chunk([1,1]));
 expect(await r.accept(b,chunk([1,3,1,1,3,1]))).toBe(true);
 expect(r.summary).toMatchObject({points:4,geometryBytes:96,limited:1,complete:false});
 expect([...r.blocks[1].cloudTypes!]).toEqual([1,1]);
 expect([...r.blocks[1].positions]).toEqual([1,2,3,4,5,6]);
 expect(r.nextBatch()).toEqual([]);
 // a is retained until b's full rows need its room
 r.reconcile([b],'dense');expect(r.summary).toMatchObject({points:2,retained:1});
 await r.accept(b,chunk([1,3,1,1,3,1]));
 expect(r.summary).toMatchObject({points:4,limited:0,complete:true});
});

test('invalid and out-of-domain coordinates consume no drawn-row budget',async()=>{
 const r=new WorldResidency(48,32),a=node('a',5),c=chunk([1,1,1,3,1]);
 c.positions[3]=NaN;c.positions[6]=1000001;
 r.reconcile([a],'dense');await r.accept(a,c);
 expect(r.summary).toMatchObject({points:2,geometryBytes:48,decodedBytes:32,limited:0});
 expect([...r.blocks[0].positions]).toEqual([1,2,3,5,6,7]);
});

test('removed solve rows consume no budget and a changed accepted set replans the native rows',async()=>{
 const r=new WorldResidency(48,36),a=node('a',4),b=node('b',2);
 const raw={...chunk([1,1,1,1]),views:new Uint16Array([1,1,0,0])};
 r.reconcile([a,b],'dense',[1]);await r.accept(a,raw);
 expect(r.summary).toMatchObject({points:2,geometryBytes:48,decodedBytes:36,limited:0});
 expect([...r.blocks[0].positions]).toEqual([3,4,5,4,5,6]);
 r.reconcile([a,b],'dense',[0]);expect(r.summary.points).toBe(0);
 await r.accept(a,raw);expect([...r.blocks[0].positions]).toEqual([1,2,3,2,3,4]);
 r.reconcile([b],'dense',[0]);
 await r.accept(b,{...chunk([1,1]),views:new Uint16Array([0,0])});
 // b's rows are all removed-solve rows (a zero block); a, from the same accepted set, is retained
 expect(r.summary).toMatchObject({points:2,retained:1,limited:0,complete:true});
 r.reconcile([a],'dense',[1]);
 await expect(r.accept(a,chunk([1,1,1,1]))).rejects.toThrow('source indices missing');
});


test('newly nearby detail displaces lower-ranked resident blocks within unchanged caps',async()=>{
 const r=new WorldResidency(96,72),far=node('far',4),near={...node('near',4),depth:8};
 r.reconcile([far],'dense');await r.accept(far,chunk([1,1,1,1]));
 r.reconcile([near,far],'dense');expect(r.summary.points).toBe(4);expect(r.priorityPoints).toBe(0);
 expect(r.nextBatch(1)).toEqual([near]);await r.accept(near,chunk([1,1,1,1]));
 expect(r.resident.map(n=>n.key)).toEqual(['near']);expect(r.priorityPoints).toBe(4);expect(r.summary).toMatchObject({points:4,geometryBytes:96,decodedBytes:64});
 expect(await r.accept(far,chunk([1,1,1,1]))).toBe(false);
 expect(r.resident.map(n=>n.key)).toEqual(['near']);
});

test('a small near batch never waits for a farther priority band even when both fit',()=>{
 const r=new WorldResidency(),near=node('near',20),far=node('far',20);
 r.reconcile([near,far],'dense');
 expect(r.nextBatch(12,400000,n=>n.key==='near'?1:3)).toEqual([near]);
 expect(r.nextBatch(64,2000000)).toEqual([near,far]);
});

test('bulk batches stop at the remaining near-prefix room instead of prefetching a useless tail',async()=>{
 const r=new WorldResidency(96,72),nodes=Array.from({length:20},(_,i)=>node(String(i),2));
 r.reconcile(nodes,'dense');await r.accept(nodes[0],chunk([1,1]));
 expect(r.nextBatch(64,2000000)).toEqual([nodes[1]]);
 await r.accept(nodes[1],chunk([1,1]));
 // A single compressed node may need sampling; no extra nodes accompany it.
 expect(r.nextBatch(64,2000000)).toEqual([nodes[2]]);
});

test('a snapshot adopted by an empty residency is the same blocks, and its view reads nothing again (ea14 A-2b)',async()=>{
	const r=new WorldResidency(24*10,16*10),a=node('a',2),b={...node('b',2),depth:3},ca=chunk([1,1]),cb=chunk([1,1]);
	r.reconcile([a,b],'dense');await r.accept(a,ca);await r.accept(b,cb);
	const s=r.snapshot('tree|placed');r.clear();
	// taken as it was, not copied, and the residency it came from leaving changes nothing in it
	expect(Object.isFrozen(s)&&Object.isFrozen(s.blocks)&&Object.isFrozen(s.blocks[0])).toBe(true);
	expect(s.blocks.map(x=>x.chunk)).toEqual([ca,cb]);expect(s.blocks[0].chunk).toBe(ca);
	const q=new WorldResidency(24*10,16*10);expect(q.adopt(s,'tree|placed')).toBe(0);
	expect(q.blocks[0]).toBe(ca);expect(q.blocks[1]).toBe(cb);
	// no plan yet: held and drawn, as retained blocks
	expect(q.summary).toMatchObject({points:4,decodedBytes:64,nodes:0,retained:2,limited:0});
	q.reconcile([a,b],'dense');expect(q.nextBatch()).toEqual([]);
	expect(q.summary).toMatchObject({points:4,nodes:2,retained:0,pending:0,complete:true});
	expect(q.planned.map(n=>n.key)).toEqual(['a','b']);
	// a view wanting more reads only what it lacks
	const c=node('c',2);q.reconcile([a,b,c],'dense');expect(q.nextBatch()).toEqual([c]);
});

test('an adopted sampled block is read again at the next reconcile; another mode or hidden set drops them all',async()=>{
	const r=new WorldResidency(24*3,16*3),a=node('a',2),b={...node('b',2),depth:4};
	r.reconcile([a,b],'dense');await r.accept(a,chunk([1,1]));await r.accept(b,chunk([1,1]));
	expect(r.summary).toMatchObject({points:3,limited:1});   // b kept one of its two rows
	const s=r.snapshot('k'),q=new WorldResidency(24*3,16*3);q.adopt(s,'k');
	expect(q.summary).toMatchObject({points:3,limited:1});expect(q.nextBatch()).toEqual([]);
	q.reconcile([a,b],'dense');expect(q.summary).toMatchObject({points:2,limited:0});expect(q.nextBatch()).toEqual([b]);
	const m=new WorldResidency(24*3,16*3);m.adopt(s,'k');m.reconcile([a],'all');expect(m.summary.points).toBe(0);
	const h=new WorldResidency(24*3,16*3);h.adopt(s,'k');h.reconcile([a],'dense',[7]);expect(h.summary.points).toBe(0);
	// the snapshot's own mode and hidden sources come with it: a run's tree ('all'), a world with a run removed
	const t=new WorldResidency(240,180),u=node('u',2);t.reconcile([u],'all',[3]);
	await t.accept(u,{...chunk([1,3]),views:new Uint16Array([1,2])});
	const v=new WorldResidency(240,180);v.adopt(t.snapshot('k'),'k');v.reconcile([u],'all',[3]);
	expect(v.summary).toMatchObject({points:2,nodes:1});
});

test('a placed snapshot keeps its placed rows and their charge',async()=>{
	const r=new WorldResidency(24*10,30*4),a=node('a',3);
	const place:WorldPlacement={bytesPerRow:30,rows:async(c)=>({...c,positions:c.positions.map(v=>v+100),
		linear:new Float32Array(c.positions.length)})};
	r.reconcile([a],'dense');await r.accept(a,chunk([1,1,1]),undefined,place);
	const q=new WorldResidency(24*10,30*4);q.adopt(r.snapshot('k'),'k');
	expect([...q.blocks[0].positions.slice(0,3)]).toEqual([101,102,103]);
	expect(q.summary).toMatchObject({points:3,decodedBytes:84});
});

test('adopt keeps its own bounds: the finest blocks go first, then the least recently wanted',async()=>{
	const r=new WorldResidency(24*10,16*10);
	const old={...node('old',2),depth:1},coarse={...node('coarse',2),depth:1},fine={...node('fine',2),depth:5};
	r.reconcile([old],'dense');await r.accept(old,chunk([1,1]));
	r.reconcile([coarse,fine],'dense');await r.accept(coarse,chunk([1,1]));await r.accept(fine,chunk([1,1]));
	const s=r.snapshot('k'),q=new WorldResidency(24*2,16*2);
	expect(q.adopt(s,'k')).toBe(2);
	expect(q.resident.map(n=>n.key)).toEqual(['coarse']);expect(q.summary).toMatchObject({points:2,decodedBytes:32});
	// the same order is kept for the room a later block needs: old, wanted longer ago, before coarse
	const w=new WorldResidency(24*4,16*4);expect(w.adopt(s,'k')).toBe(1);
	const next=node('next',2);w.reconcile([next],'dense');await w.accept(next,chunk([1,1]));
	expect(w.resident.map(n=>n.key)).toEqual(['next','coarse']);
});

test('adopt refuses another key, a residency already holding blocks, and a block whose arrays disagree',async()=>{
	const r=new WorldResidency(24*10,16*10),a=node('a',2);r.reconcile([a],'dense');await r.accept(a,chunk([1,1]));
	const s=r.snapshot('k');
	expect(()=>r.snapshot('')).toThrow('needs the key');
	expect(()=>new WorldResidency(240,160).adopt(s,'other')).toThrow('cannot be adopted as other');
	expect(()=>r.adopt(s,'k')).toThrow('Only an empty residency');
	const bad={...s,blocks:[{...s.blocks[0],chunk:{...s.blocks[0].chunk,colors:new Uint8Array(3)}}]};
	expect(()=>new WorldResidency(240,160).adopt(bad,'k')).toThrow('Invalid residency snapshot block');
	expect(()=>new WorldResidency(240,160).adopt({...s,blocks:[s.blocks[0],s.blocks[0]]},'k')).toThrow('Invalid');
});

test('adopt ends an accept in flight, as clear does',async()=>{
	const q=new WorldResidency(240,160),a=node('a',2),b=node('b',2);q.reconcile([b],'dense');
	let release!:()=>void;const gate=new Promise<void>(go=>{release=go;});
	const pending=q.accept(b,chunk([1,1]),()=>gate);
	const r=new WorldResidency(240,160);r.reconcile([a],'dense');await r.accept(a,chunk([1,1]));
	q.adopt(r.snapshot('k'),'k');release();
	expect(await pending).toBe(false);expect(q.resident.map(n=>n.key)).toEqual(['a']);
});
