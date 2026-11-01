import {expect,test} from 'vitest';
import {planWorldView,worldBatch} from './worldView';
import type {CopcNode} from './copcSource';
const n=(key:string,depth:number):CopcNode=>({key,depth,bounds:[0,0,0,1,1,1],pointCount:100});
test('near visible fine detail outranks distant shallow detail and off-screen overview',()=>{
 const nodes=[n('offscreen',1),n('far',2),n('near',8),n('mid',4)];
 const measures={offscreen:{visible:false,distance:1,pixels:400},far:{visible:true,distance:900,pixels:500},near:{visible:true,distance:20,pixels:100},mid:{visible:true,distance:150,pixels:200}};
 expect(planWorldView(nodes,r=>measures[r.key as keyof typeof measures]).map(r=>r.key)).toEqual(['near','mid','far','offscreen']);
});
test('ranking preserves eligibility and input records, including coarse coverage',()=>{
 const nodes=[n('coarse',1),n('small',5),n('behind',5),n('fine',9)];
 const measures={coarse:{visible:false,distance:20,pixels:1},small:{visible:true,distance:20,pixels:63},behind:{visible:false,distance:20,pixels:1000},fine:{visible:true,distance:20,pixels:64}};
 const output=planWorldView(nodes,r=>measures[r.key as keyof typeof measures]);
 expect(output).toEqual([nodes[3],nodes[0]]);expect(nodes.map(r=>r.key)).toEqual(['coarse','small','behind','fine']);
});
test('equal-distance visible nodes retain coarse-first and stable input ordering',()=>{
 const nodes=[n('deep',8),n('a',2),n('b',2)];
 expect(planWorldView(nodes,()=>({visible:true,distance:50,pixels:100})).map(r=>r.key)).toEqual(['a','b','deep']);
});

test('early nearby batches stay separate; later tiny blocks coalesce within the same raw cap',()=>{
 expect(worldBatch(0,false)).toEqual({maxNodes:1,rawPoints:400000,separateNear:true});
 expect(worldBatch(199999,true)).toEqual({maxNodes:12,rawPoints:400000,separateNear:true});
 expect(worldBatch(200000,true)).toEqual({maxNodes:64,rawPoints:400000,separateNear:false});
 expect(worldBatch(5000000,true)).toEqual({maxNodes:64,rawPoints:2000000,separateNear:false});
});
