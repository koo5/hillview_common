import {expect,test} from 'vitest';
import {CopcChunkCache} from './copcCache';
const chunk=()=>({positions:new Float32Array([1,2,3]),colors:new Uint8Array([4,5,6]),views:new Uint16Array([7])});
test('cached nodes survive mutable placement, section filtering and repeated reads',()=>{
	const cache=new CopcChunkCache(34),original=chunk();cache.set('node|1',original);
	original.positions[0]=100;original.colors[0]=0;original.views[0]=0;
	const first=cache.get('node|1')!;expect([...first.positions]).toEqual([1,2,3]);
	first.positions[0]=200;first.colors[0]=1;first.views![0]=1;
	const next=cache.get('node|1')!;
	expect([...next.positions,...next.colors,...next.views!]).toEqual([1,2,3,4,5,6,7]);
	expect(cache.byteLength).toBe(17);
});
test('least recently used nodes evict within the byte budget; oversize nodes are not retained',()=>{
	const cache=new CopcChunkCache(34);
	cache.set('a',chunk());cache.set('b',chunk());cache.get('a');cache.set('c',chunk());
	expect(cache.get('b')).toBeUndefined();expect(cache.get('a')).toBeDefined();expect(cache.get('c')).toBeDefined();
	cache.set('large',{positions:new Float32Array(30),colors:new Uint8Array(30),views:null});
	expect(cache.get('large')).toBeUndefined();expect(cache.byteLength).toBe(34);
	cache.clear();expect(cache.byteLength).toBe(0);expect(cache.get('a')).toBeUndefined();
});

test('world source tags survive cache isolation and count toward the budget',()=>{
	const cache=new CopcChunkCache(35),source={...chunk(),cloudTypes:new Uint8Array([1])};
	cache.set('dense',source);source.cloudTypes[0]=2;
	const first=cache.get('dense')!;expect(first.cloudTypes?.[0]).toBe(1);
	first.cloudTypes![0]=2;expect(cache.get('dense')?.cloudTypes?.[0]).toBe(1);
	cache.set('sparse',{...chunk(),cloudTypes:new Uint8Array([2])});
	expect(cache.get('dense')).toBeUndefined();expect(cache.byteLength).toBe(18);
});
