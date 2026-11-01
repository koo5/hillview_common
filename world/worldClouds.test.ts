import {expect,test} from 'vitest';
import {type DenseResolution,worldCloudCounts} from './worldClouds';
const key='0123456789abcdef';
const resolution=(full:boolean,dense:number,sparse:number):DenseResolution=>({full,state:full?'full':'not_home_yet',source:full?'dense_full':null,expected_dense_points:200,included_dense_points:dense,sparse_points:sparse,reason:full?'':'Full resolution not home yet',provenance:full?{kind:'producer',exact:true,label:'saved full stream, exact'}:null});
const manifest=()=>({schema:3,resolution:'full',key,field:'UserData',kinds:{dense:1},full:false,runs:[{i:0,id:'a',dense:200,sparse:0,dense_resolution:resolution(true,200,0)},{i:1,id:'b',dense:0,sparse:0,dense_resolution:resolution(false,0,0)}]});
test('a missing dense source contributes no browser points',()=>{
	const counts=worldCloudCounts(manifest(),key,['a','b']);
	expect(counts.get('a')).toEqual({dense:200,sparse:0,resolution:resolution(true,200,0)});
	expect(counts.get('b')).toEqual({dense:0,sparse:0,resolution:resolution(false,0,0)});
});
test('legacy mixed files and any sparse counts are refused',()=>{
 for(const value of [{...manifest(),schema:2,kinds:{dense:1,sparse:2}},
  {...manifest(),kinds:{dense:1,sparse:2}},
  {...manifest(),runs:manifest().runs.map(r=>({...r,sparse:1}))}])
  expect(()=>worldCloudCounts(value,key,['a','b'])).toThrow('rebuild');
});
test('unknown cloud metadata never silently assumes dense',()=>{
	for(const value of [undefined,{}, {...manifest(),field:'Classification'}, {...manifest(),key:'fedcba9876543210'}])
		expect(()=>worldCloudCounts(value,key,['a','b'])).toThrow('rebuild');
});
test('a manifest cannot omit, repeat or replace an accepted run',()=>{
	for(const runs of [[manifest().runs[0]], [manifest().runs[0],{...manifest().runs[1],id:'a'}],
		[manifest().runs[0],{...manifest().runs[1],id:'other'}]])
		expect(()=>worldCloudCounts({...manifest(),runs},key,['a','b'])).toThrow();
});
test('invalid source counts refuse rather than turn into presence flags',()=>{
	for(const dense of [true,-1,NaN,1.5,'200'])
		expect(()=>worldCloudCounts({...manifest(),runs:[{i:0,id:'a',dense,sparse:1}]},key,['a'])).toThrow();
});

test('capped counts or missing completeness cannot masquerade as full',()=>{
 for(const value of [{...manifest(),schema:1},{...manifest(),full:true},
  {...manifest(),runs:manifest().runs.map(r=>({...r,dense_resolution:{...r.dense_resolution,full:true}}))}])
  expect(()=>worldCloudCounts(value,key,['a','b'])).toThrow();
});

test('a full source can be approximate and must disclose its re-derived provenance',()=>{
 const value=manifest();value.runs[0].dense_resolution.provenance={kind:'rederived',route:'solver',tool_rev:1,exact:false,label:'re-derived, approximate'};
 expect(worldCloudCounts(value,key,['a','b']).get('a')!.resolution!.provenance!.exact).toBe(false);
 value.runs[0].dense_resolution.provenance=null;
 expect(()=>worldCloudCounts(value,key,['a','b'])).toThrow();
});

test('stored and full manifests cannot substitute for each other',()=>{
 const stored={...manifest(),resolution:'stored',full:false,runs:manifest().runs.map(r=>({...r,dense_resolution:null}))};
 expect(worldCloudCounts(stored,key,['a','b'],'stored').get('a')).toEqual({dense:200,sparse:0,resolution:null});
 expect(()=>worldCloudCounts(stored,key,['a','b'],'full')).toThrow();
 expect(()=>worldCloudCounts(manifest(),key,['a','b'],'stored')).toThrow();
 expect(()=>worldCloudCounts({...stored,runs:manifest().runs},key,['a','b'],'stored')).toThrow();
});

test('a nearest-ownership world draws the kept part and checks the full stream against owned_from',()=>{
 const value={...manifest(),overlap:'nearest',runs:manifest().runs.map(r=>({...r,dense:r.dense?150:0,owned_from:r.dense}))};
 expect(worldCloudCounts(value,key,['a','b']).get('a')).toEqual({dense:150,sparse:0,resolution:resolution(true,200,0),owned_from:200});
 for(const bad of [{...value,overlap:'all'},{...value,overlap:'farthest'},
  {...value,runs:value.runs.map(r=>({...r,owned_from:undefined}))},
  {...value,runs:value.runs.map(({owned_from,...r})=>r)},
  {...value,runs:value.runs.map(r=>({...r,owned_from:r.dense?100:0}))},
  {...manifest(),runs:value.runs}])
  expect(()=>worldCloudCounts(bad,key,['a','b'])).toThrow('rebuild');
});
