import { expect,test } from 'vitest';
import { readCopcRange } from './copcRange';
import type { ResourceRead } from './worldRequests';

test('empty ranges never reach HTTP; invalid spans refuse',async()=>{
	const read: ResourceRead=async()=>{throw new Error('must not fetch');};
	expect((await readCopcRange(read,'/x',0,0)).length).toBe(0);
	for(const [begin,end] of [[-1,1],[1,0],[0,NaN],[0,Infinity],[0,1.5]])
		await expect(readCopcRange(read,'/x',begin,end)).rejects.toThrow('Invalid COPC byte span');
});
test('range response must match its asked bytes, including truncated header reads',async()=>{
	const read:ResourceRead=async(_url,init,consume)=>{
		expect(new Headers(init?.headers).get('Range')).toBe('bytes=0-65535');
		return consume(new Response(new Uint8Array(10),{status:206,headers:{'Content-Range':'bytes 0-9/10'}}));
	};
	expect((await readCopcRange(read,'/x',0,65536)).length).toBe(10);
});
test('lying 206 full-file or truncated responses fail loudly',async()=>{
	for(const header of ['bytes 0-99/100','bytes 2-3/100',null]) {
		const read:ResourceRead=async(_url,_init,consume)=>consume(new Response(new Uint8Array(4),{status:206,headers:header?{'Content-Range':header}:{}}));
		await expect(readCopcRange(read,'/x',0,4)).rejects.toThrow('does not match');
	}
});

test('a changed world key refuses before consuming the wrong tree',async()=>{
	let consumed=false;
	const read:ResourceRead=async(_url,_init,consume)=>{
		const response=new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 0-3/100','X-World-Key':'fedcba9876543210'}});
		response.arrayBuffer=async()=>{consumed=true;return new ArrayBuffer(4);};
		return consume(response);
	};
	await expect(readCopcRange(read,'/world?key=0123456789abcdef',0,4)).rejects.toThrow('different world snapshot');
	expect(consumed).toBe(false);
});

test('world spans use immutable ordinary asset URLs and validate their product and body',async()=>{
 let requested='';const key='0123456789abcdef';
 const read:ResourceRead=async(url,init,consume)=>{
  requested=url;expect(new Headers(init?.headers).has('Range')).toBe(false);
  return consume(new Response(new Uint8Array(4),{status:200,headers:{'X-Copc-Range':'bytes 8-11/100','X-World-Key':key,'X-World-Resolution':'full'}}));
 };
 expect((await readCopcRange(read,`/api/atlas/world.copc.laz?key=${key}&resolution=full`,8,12)).length).toBe(4);
 expect(new URL(requested,'http://test').searchParams.get('begin')).toBe('8');
 expect(new URL(requested,'http://test').searchParams.get('end')).toBe('12');
 const oldProtocol:ResourceRead=async(_u,_i,consume)=>consume(new Response(new Uint8Array(4),{status:206,headers:{'Content-Range':'bytes 8-11/100','X-World-Key':key}}));
 await expect(readCopcRange(oldProtocol,`/api/atlas/world.copc.laz?key=${key}&resolution=full`,8,12)).rejects.toThrow('HTTP 206');
});

test('world assets reject another product or a lying span without returning its bytes',async()=>{
 const key='0123456789abcdef',url=`/api/atlas/world.copc.laz?key=${key}&resolution=full`;
 for(const headers of [
  {'X-Copc-Range':'bytes 0-3/100','X-World-Key':key,'X-World-Resolution':'stored'},
  {'X-Copc-Range':'bytes 0-99/100','X-World-Key':key,'X-World-Resolution':'full'}
 ]){
  const read:ResourceRead=async(_u,_i,consume)=>consume(new Response(new Uint8Array(4),{status:200,headers}));
  await expect(readCopcRange(read,url,0,4)).rejects.toThrow();
 }
});
