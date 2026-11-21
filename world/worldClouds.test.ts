import {expect,test} from 'vitest';
import {type DenseResolution,type FoliageResolution,worldCloudCounts} from './worldClouds';
const key='0123456789abcdef';
const resolution=(full:boolean,dense:number,sparse:number):DenseResolution=>({full,state:full?'full':'not_home_yet',source:full?'dense_full':null,expected_dense_points:200,included_dense_points:dense,sparse_points:sparse,reason:full?'':'Full resolution not home yet',provenance:full?{kind:'producer',exact:true,label:'saved full stream, exact'}:null});
const manifest=()=>({schema:3,resolution:'full',key,field:'UserData',kinds:{dense:1},full:false,runs:[{i:0,id:'a',dense:200,sparse:0,dense_resolution:resolution(true,200,0)},{i:1,id:'b',dense:0,sparse:0,dense_resolution:resolution(false,0,0)}]});
test('a missing dense source contributes no browser points',()=>{
	const counts=worldCloudCounts(manifest(),key,['a','b']);
	expect(counts.get('a')).toEqual({dense:200,sparse:0,resolution:resolution(true,200,0),foliage:0});
	expect(counts.get('b')).toEqual({dense:0,sparse:0,resolution:resolution(false,0,0),foliage:0});
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
 expect(worldCloudCounts(stored,key,['a','b'],'stored').get('a')).toEqual({dense:200,sparse:0,resolution:null,foliage:0});
 expect(()=>worldCloudCounts(stored,key,['a','b'],'full')).toThrow();
 expect(()=>worldCloudCounts(manifest(),key,['a','b'],'stored')).toThrow();
 expect(()=>worldCloudCounts({...stored,runs:manifest().runs},key,['a','b'],'stored')).toThrow();
});

test('a nearest-ownership world draws the kept part and checks the full stream against owned_from',()=>{
 const value={...manifest(),overlap:'nearest',runs:manifest().runs.map(r=>({...r,dense:r.dense?150:0,owned_from:r.dense}))};
 expect(worldCloudCounts(value,key,['a','b']).get('a')).toEqual({dense:150,sparse:0,resolution:resolution(true,200,0),owned_from:200,foliage:0});
 for(const bad of [{...value,overlap:'all'},{...value,overlap:'farthest'},
  {...value,runs:value.runs.map(r=>({...r,owned_from:undefined}))},
  {...value,runs:value.runs.map(({owned_from,...r})=>r)},
  {...value,runs:value.runs.map(r=>({...r,owned_from:r.dense?100:0}))},
  {...manifest(),runs:value.runs}])
  expect(()=>worldCloudCounts(bad,key,['a','b'])).toThrow('rebuild');
});

test('a drawn-ownership world (the nearest drawing run per voxel) reads like a nearest one',()=>{
 const value={...manifest(),overlap:'drawn',runs:manifest().runs.map(r=>({...r,dense:r.dense?180:0,owned_from:r.dense}))};
 expect(worldCloudCounts(value,key,['a','b']).get('a')).toEqual({dense:180,sparse:0,resolution:resolution(true,200,0),owned_from:200,foliage:0});
 expect(()=>worldCloudCounts({...value,runs:value.runs.map(({owned_from,...r})=>r)},key,['a','b'])).toThrow('rebuild');
});

test('a drawn_once world reads like the other ownership worlds',()=>{
 const value={...manifest(),overlap:'drawn_once',runs:manifest().runs.map(r=>({...r,dense:r.dense?150:0,owned_from:r.dense}))};
 expect(worldCloudCounts(value,key,['a','b']).get('a')).toEqual({dense:150,sparse:0,resolution:resolution(true,200,0),owned_from:200,foliage:0});
 expect(()=>worldCloudCounts({...value,runs:value.runs.map(({owned_from,...r})=>r)},key,['a','b'])).toThrow('rebuild');
 expect(()=>worldCloudCounts({...value,overlap:'drawn_twice'},key,['a','b'])).toThrow('rebuild');
});

// A WORLD WITH FOLIAGE (ATLAS2, recon/directions aw02): schema 4, kinds {dense: 1, foliage: 3}; the API's
// world_build.source_manifest writes it and world_sources.validate_manifest reads it the same way
const leaves=(state:FoliageResolution['state'],n:number,expected:number|null=n):FoliageResolution=>
 ({state,expected_points:expected,included_points:n,reason:state==='full'?'':'why'});
const withFoliage=()=>({...manifest(),schema:4,kinds:{dense:1,foliage:3},runs:[
 {...manifest().runs[0],foliage:40,foliage_from:'arm',foliage_resolution:leaves('full',40)},
 {...manifest().runs[1],foliage:0}]});
test('a world that names a foliage source states each run\'s foliage and where it comes from',()=>{
 const counts=worldCloudCounts(withFoliage(),key,['a','b']);
 expect(counts.get('a')).toEqual({dense:200,sparse:0,resolution:resolution(true,200,0),foliage:40,foliage_from:'arm',
  foliage_resolution:leaves('full',40)});
 expect(counts.get('b')).toEqual({dense:0,sparse:0,resolution:resolution(false,0,0),foliage:0});
 // named, and nothing in this product: a cut file, a stream not home, a source that broke -- each says why
 for(const state of ['capped','not_home_yet'] as const){
  const value=withFoliage();value.runs[0]={...value.runs[0],foliage:0,foliage_resolution:leaves(state,0,40)};
  expect(worldCloudCounts(value,key,['a','b']).get('a')!.foliage_resolution!.state).toBe(state);
 }
 const broken=withFoliage();broken.runs[0]={...broken.runs[0],foliage:0,foliage_resolution:leaves('unavailable',0,null)};
 expect(worldCloudCounts(broken,key,['a','b']).get('a')!.foliage).toBe(0);
});
test('a stored world with foliage states no resolution, and an ownership world what the foliage was kept from',()=>{
 const stored={...withFoliage(),resolution:'stored',full:false,runs:withFoliage().runs.map(r=>({...r,dense_resolution:null,
  ...('foliage_from' in r?{foliage_resolution:null}:{})}))};
 expect(worldCloudCounts(stored,key,['a','b'],'stored').get('a')).toMatchObject({foliage:40,foliage_from:'arm',foliage_resolution:null});
 const owned={...withFoliage(),overlap:'drawn',runs:withFoliage().runs.map(r=>({...r,owned_from:r.dense,
  ...('foliage_from' in r?{foliage:30,foliage_owned_from:40}:{})}))};
 expect(worldCloudCounts(owned,key,['a','b']).get('a')).toMatchObject({foliage:30,foliage_owned_from:40});
});
test('foliage fields that disagree, or foliage in a world that names none, are refused',()=>{
 const row0=(patch:Record<string,unknown>)=>{const v:any=withFoliage();v.runs[0]={...v.runs[0],...patch};return v;};
 const bad=[
  {...manifest(),runs:manifest().runs.map(r=>({...r,foliage:0}))},                     // schema 3 with foliage fields
  {...withFoliage(),schema:3},                                                         // the same, by its kinds
  {...withFoliage(),kinds:{dense:1}},{...withFoliage(),kinds:{dense:1,foliage:2}},
  {...withFoliage(),kinds:{dense:1,foliage:3,sparse:2}},
  {...withFoliage(),runs:withFoliage().runs.map(({foliage_from,foliage_resolution,...r}:any)=>({...r,foliage:0}))},
  row0({foliage:-1}),row0({foliage:1.5}),row0({foliage_from:''}),row0({foliage_resolution:undefined}),
  row0({foliage_resolution:leaves('full',39)}),row0({foliage_resolution:leaves('full',40,41)}),
  row0({foliage_resolution:leaves('capped',40,50)}),row0({foliage_resolution:{...leaves('capped',0,40),reason:''}}),
  row0({foliage_resolution:leaves('unavailable',0,40)}),row0({foliage_resolution:leaves('thinned' as any,40)}),
  row0({foliage_owned_from:40}),
 ];
 for(const value of bad)expect(()=>worldCloudCounts(value,key,['a','b'])).toThrow('rebuild');
 const v:any=withFoliage();v.runs[1]={...v.runs[1],foliage:5};                         // foliage on a run naming none
 expect(()=>worldCloudCounts(v,key,['a','b'])).toThrow('rebuild');
});
