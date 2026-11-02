/** Native LAS UserData values. PointSourceId independently identifies the solve. */
export const DENSE_CLOUD = 1;
export const SPARSE_CLOUD = 2;
export type FullSourceProvenance = {kind:'producer'|'uncapped_ply'|'rederived';exact:boolean;label:string;route?:'exact'|'solver';tool_rev?:number};
export type DenseResolution = {
 full: boolean; state: 'full'|'not_home_yet'|'unavailable'; source: 'dense_full'|'uncapped_ply'|null;
 expected_dense_points: number|null; included_dense_points: number; sparse_points: number; reason: string; provenance: FullSourceProvenance|null;
};
export type WorldResolution = 'stored'|'full';
/** dense = points drawn. In an ownership world (overlap: 'nearest' or 'drawn', ATLAS2's rules) owned_from is the run's
 *  source count before ownership, and the full-stream counts in dense_resolution describe that source. */
export type WorldCloudCounts = { dense: number; sparse: number; resolution: DenseResolution|null; owned_from?: number };

export function worldCloudCounts(value: unknown, key: string, ids: string[], mode:WorldResolution = 'full'): Map<string, WorldCloudCounts> {
	const bad=()=>new Error('World cloud-source metadata missing or invalid; rebuild the merged octree');
	if(!value||typeof value!=='object')throw bad();
	const data=value as Record<string,unknown>;
	const kinds=data.kinds as Record<string,unknown>|undefined;
	if(data.schema!==3||data.resolution!==mode||data.key!==key||data.field!=='UserData'||kinds?.dense!==DENSE_CLOUD||Object.keys(kinds).length!==1||!Array.isArray(data.runs)||data.runs.length!==ids.length||
		('overlap' in data&&data.overlap!=='nearest'&&data.overlap!=='drawn'))throw bad();
	const owned='overlap' in data;
	const result=new Map<string,WorldCloudCounts>();
	for(const [index,row]of data.runs.entries()){
		if(!row||typeof row!=='object')throw bad();
		const r=row as Record<string,unknown>;
		if(r.i!==index||typeof r.id!=='string'||!ids.includes(r.id)||result.has(r.id)||
			typeof r.dense!=='number'||!Number.isSafeInteger(r.dense)||r.dense<0||
			typeof r.sparse!=='number'||r.sparse!==0||owned!==('owned_from' in r)||
			(owned&&(typeof r.owned_from!=='number'||!Number.isSafeInteger(r.owned_from)||r.owned_from<r.dense)))throw bad();
		const source=owned?r.owned_from as number:r.dense;
		const ownership=owned?{owned_from:source}:{};
		if(mode==='stored'){
            if(r.dense_resolution!==null)throw bad();
            result.set(r.id,{dense:r.dense,sparse:r.sparse,resolution:null,...ownership});
            continue;
        }
        const resolution=r.dense_resolution as DenseResolution|undefined;
        if(!resolution||typeof resolution.full!=='boolean'||typeof resolution.reason!=='string'||
            !['full','not_home_yet','unavailable'].includes(resolution.state)||
            resolution.full!==(resolution.state==='full')||
            resolution.included_dense_points!==source||resolution.sparse_points!==r.sparse||
            (!resolution.full&&(source!==0||!resolution.reason))||
            (resolution.full&&(!['dense_full','uncapped_ply'].includes(resolution.source||'')||resolution.expected_dense_points!==source))||
            (resolution.expected_dense_points!==null&&(!Number.isSafeInteger(resolution.expected_dense_points)||resolution.expected_dense_points<0)))throw bad();
        const provenance=resolution.provenance;
        if(resolution.full&&(!provenance||!['producer','uncapped_ply','rederived'].includes(provenance.kind)||
            typeof provenance.exact!=='boolean'||typeof provenance.label!=='string'||
            (provenance.kind==='rederived'&&(!['exact','solver'].includes(provenance.route||'')||provenance.tool_rev!==1||provenance.exact!==(provenance.route==='exact')))))throw bad();
        result.set(r.id,{dense:r.dense,sparse:r.sparse,resolution,...ownership});
	}
	if(typeof data.full!=='boolean'||data.full!==(mode==='full'&&result.size>0&&[...result.values()].every(r=>r.resolution?.full)))throw bad();
	return result;
}
