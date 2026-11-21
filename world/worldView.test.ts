import {expect,test} from 'vitest';
import * as THREE from 'three';
import {cameraMeasure,mergeWorldPlans,planWorldView,rankWorldView,worldBatch} from './worldView';
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


const node=(key:string,bounds:[number,number,number,number,number,number]):CopcNode=>
	({key,depth:2,bounds,pointCount:10} as unknown as CopcNode);

test('the camera measure: in front and near is visible, behind is not, nearer spans more pixels',()=>{
	const camera=new THREE.PerspectiveCamera(60,1,0.1,1000);
	camera.position.set(0,0,0);camera.lookAt(0,10,0);camera.updateProjectionMatrix();
	const {measure,nearGroups}=cameraMeasure(THREE,camera,[0,0,0],800,false);
	const ahead=measure(node('ahead',[-1,9,-1,1,11,1]));
	const far=measure(node('far',[-1,99,-1,1,101,1]));
	const behind=measure(node('behind',[-1,-11,-1,1,-9,1]));
	expect(ahead.visible).toBe(true);
	expect(behind.visible).toBe(false);
	expect(ahead.distance).toBeCloseTo(9);
	expect(ahead.pixels).toBeGreaterThan(far.pixels);
	expect(nearGroups.get('ahead')).toBe(3);
	expect(nearGroups.get('behind')).toBe(-1);
	// the offset carries the tree's file coordinates into the scene
	const shifted=cameraMeasure(THREE,camera,[0,-100,0],800,false).measure(node('shifted',[-1,99,-1,1,101,1]));
	expect(shifted.distance).toBeLessThan(1.5);
});

test('two trees merge into one ranking: in view first, then nearer, then coarser, ties in plan order',()=>{
 const a=[n('a-near',3),n('a-far',2),n('a-off',1)],b=[n('b-mid',4),n('b-near',5)];
 const m:{[k:string]:{visible:boolean;distance:number;pixels:number}}={'a-near':{visible:true,distance:10,pixels:500},
  'a-far':{visible:true,distance:900,pixels:500},'a-off':{visible:false,distance:5,pixels:500},
  'b-mid':{visible:true,distance:200,pixels:500},'b-near':{visible:true,distance:10,pixels:500}};
 const ra=rankWorldView(a,r=>m[r.key]),rb=rankWorldView(b,r=>m[r.key]);
 expect(ra.map(r=>r.node.key)).toEqual(planWorldView(a,r=>m[r.key]).map(r=>r.key));
 const merged=mergeWorldPlans([{ranked:ra,tag:'A'},{ranked:rb,tag:'B'}]);
 expect(merged.map(r=>`${r.tag}:${r.node.key}`)).toEqual(['A:a-near','B:b-near','B:b-mid','A:a-far','A:a-off']);
});
