import { RequestFailure, type ResourceRead } from './worldRequests';

/** COPC uses half-open byte spans. World blocks have ordinary immutable asset
 * URLs so browser disk caches can reuse them, including Firefox's. Per-run files
 * retain HTTP Range reads because their URL does not identify an immutable tree. */
export async function readCopcRange(read: ResourceRead,url: string,begin: number,end: number,signal?: AbortSignal): Promise<Uint8Array> {
	signal?.throwIfAborted();
	if(!Number.isSafeInteger(begin)||!Number.isSafeInteger(end)||begin<0||end<begin) throw new Error('Invalid COPC byte span');
	// Empty octants are valid hierarchy records, not a request for the whole file.
	if(begin===end) return new Uint8Array();
	const target=new URL(url,'http://relative.invalid');
	const world=target.pathname.endsWith('/atlas/world.copc.laz');
	let requestUrl=url;
	if(world){
		target.searchParams.set('begin',String(begin));target.searchParams.set('end',String(end));
		requestUrl=url.startsWith('/')?target.pathname+target.search:target.href;
	}
	return read(requestUrl,world?{signal}:{signal,headers:{Range:`bytes=${begin}-${end-1}`}},async response=>{
		if(response.status!==(world?200:206)) {
			await response.body?.cancel();
			throw new RequestFailure(`COPC range request failed (HTTP ${response.status})`,response.status>=500);
		}
		const content=response.headers.get(world?'X-Copc-Range':'Content-Range');
		const match=content && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(content);
		const expectedKey=new URL(url,'http://relative.invalid').searchParams.get('key');
		if(expectedKey && response.headers.get('X-World-Key')!==expectedKey) {
			await response.body?.cancel();
			throw new RequestFailure('COPC response names a different world snapshot; reload this view',false);
		}
		if(world&&response.headers.get('X-World-Resolution')!==target.searchParams.get('resolution')){
			await response.body?.cancel();
			throw new RequestFailure('COPC response names a different world product',false);
		}
		// Reject a lying block before reading its body. A header probe may extend past EOF.
		if(!match || Number(match[1])!==begin || Number(match[2])>=end || Number(match[2])<begin ||
			Number(match[2])>=Number(match[3])) {
			await response.body?.cancel();
			throw new RequestFailure('COPC response does not match the requested byte range',false);
		}
		return readBody(response,Number(match[2])-begin+1);
	});
}

/**
 * No byte for this long and a range read is given up, retryable, so the scheduler reads it again (ea14, 2026-11-10).
 * That catches a HUNG read and never a slow one: the timer restarts on every chunk (RECON-UI's review). Before, a hung
 * read waited out the scheduler's 180 s, and blocks are handed over in order, so it held its whole batch. A fixed
 * deadline per block instead would abort a slow phone's reads that were still arriving.
 */
export const COPC_IDLE_MS=8000;

/** The body, exactly `length` bytes, read chunk by chunk under the idle deadline. */
async function readBody(response: Response,length: number): Promise<Uint8Array> {
	if(!response.body){
		const bytes=new Uint8Array(await response.arrayBuffer());
		if(bytes.length!==length) throw new RequestFailure('COPC response length does not match its byte range',false);
		return bytes;
	}
	const out=new Uint8Array(length),reader=response.body.getReader();
	let got=0;
	try{
		for(;;){
			let timer: ReturnType<typeof setTimeout>|undefined;
			const idle=new Promise<never>((_,reject)=>{
				timer=setTimeout(()=>reject(new RequestFailure(`COPC read stalled: no byte for ${COPC_IDLE_MS/1000} s`)),COPC_IDLE_MS);
			});
			// the result's type is inferred: the lib's spelling of it differs between TypeScript setups (the workbench's
			// svelte-check refused an explicit ReadableStreamReadResult)
			const step=await Promise.race([reader.read(),idle]).finally(()=>clearTimeout(timer));
			if(step.done)break;
			if(got+step.value.length>length) throw new RequestFailure('COPC response length does not match its byte range',false);
			out.set(step.value,got);got+=step.value.length;
		}
	}catch(error){
		void reader.cancel().catch(()=>{});
		throw error;
	}
	if(got!==length) throw new RequestFailure('COPC response length does not match its byte range',false);
	return out;
}

/** Retry dropped links/timeouts and server failures, never corrupt data or another snapshot. */
export function retryCopcRead(error: unknown): boolean {
	return error instanceof TypeError || (error instanceof RequestFailure && error.retryable);
}
