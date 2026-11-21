/** Native LAS UserData values. PointSourceId independently identifies the solve. */
export const DENSE_CLOUD = 1;
/** retired 2026-11-09 (ea13): no browser world carries it, and a point with it is refused */
export const SPARSE_CLOUD = 2;
/** a solve's foliage layer (the soft pass), in a world where the atlas names where a solve's foliage comes from:
 *  the solve itself or a dense arm of it (ATLAS2, recon/directions aw02, 2026-11-15) */
export const FOLIAGE_CLOUD = 3;
export type FullSourceProvenance = {kind:'producer'|'uncapped_ply'|'rederived';exact:boolean;label:string;route?:'exact'|'solver';tool_rev?:number};
export type DenseResolution = {
 full: boolean; state: 'full'|'not_home_yet'|'unavailable'; source: 'dense_full'|'uncapped_ply'|null;
 expected_dense_points: number|null; included_dense_points: number; sparse_points: number; reason: string; provenance: FullSourceProvenance|null;
};
export type WorldResolution = 'stored'|'full';
/** How complete a named foliage source is in a full world (the API's dense_full.select_foliage): every point, or none
 *  and why -- its file is a cut ('capped'), its full stream is still on its box ('not_home_yet'), or it cannot be
 *  read ('unavailable'). A stored world takes the source's file as it is and states nothing (null). */
export type FoliageResolution = {state:'full'|'capped'|'not_home_yet'|'unavailable'; expected_points:number|null;
 included_points:number; reason:string};
/** dense = points drawn. In an ownership world (overlap: 'nearest', 'drawn' or 'drawn_once', ATLAS2's rules) owned_from is the run's
 *  source count before ownership, and the full-stream counts in dense_resolution describe that source.
 *  foliage = the run's foliage points in the tree (0 where the world names no foliage source for it); foliage_from
 *  names that source, foliage_owned_from its count before ownership. */
export type WorldCloudCounts = { dense: number; sparse: number; resolution: DenseResolution|null; owned_from?: number;
 foliage: number; foliage_from?: string; foliage_owned_from?: number; foliage_resolution?: FoliageResolution|null };
const FOLIAGE_FIELDS=['foliage','foliage_from','foliage_owned_from','foliage_resolution'];
const FOLIAGE_STATES=['full','capped','not_home_yet','unavailable'];

/** One row's foliage fields, as the API's world_sources._validate_foliage reads them: none at all in a schema-3
 *  world; in schema 4 a count on every row, and on a row that names a source its resolution (null when stored). */
function foliageCounts(r:Record<string,unknown>,schema4:boolean,owned:boolean,mode:WorldResolution,bad:()=>Error):
	Pick<WorldCloudCounts,'foliage'|'foliage_from'|'foliage_owned_from'|'foliage_resolution'> {
	if(!schema4){if(FOLIAGE_FIELDS.some(k=>k in r))throw bad();return {foliage:0};}
	const n=r.foliage;
	if(typeof n!=='number'||!Number.isSafeInteger(n)||n<0)throw bad();
	if(!('foliage_from' in r)){if(n!==0||FOLIAGE_FIELDS.slice(1).some(k=>k in r))throw bad();return {foliage:0};}
	const from=r.foliage_from,ownedFrom=r.foliage_owned_from;
	if(typeof from!=='string'||!from||!('foliage_resolution' in r)||owned!==('foliage_owned_from' in r)||
		(owned&&(typeof ownedFrom!=='number'||!Number.isSafeInteger(ownedFrom)||ownedFrom<n)))throw bad();
	const source=owned?ownedFrom as number:n;
	const named={foliage:n,foliage_from:from,...(owned?{foliage_owned_from:source}:{})};
	if(mode==='stored'){if(r.foliage_resolution!==null)throw bad();return {...named,foliage_resolution:null};}
	const res=r.foliage_resolution as FoliageResolution|null|undefined;
	if(!res||typeof res!=='object'||!FOLIAGE_STATES.includes(res.state)||typeof res.reason!=='string'||
		res.included_points!==source||(res.state==='unavailable')!==(res.expected_points===null)||
		(res.state!=='unavailable'&&(typeof res.expected_points!=='number'||!Number.isSafeInteger(res.expected_points)||
			res.expected_points<0))||
		(res.state==='full'&&res.expected_points!==source)||(res.state!=='full'&&(source!==0||!res.reason)))throw bad();
	return {...named,foliage_resolution:res};
}

/** The ownership rules a world's manifest may name (the API's world_sources.validate_manifest reads the same three). */
export const OWNERSHIP_RULES: readonly string[] = ['nearest', 'drawn', 'drawn_once'];

export function worldCloudCounts(value: unknown, key: string, ids: string[], mode:WorldResolution = 'full'): Map<string, WorldCloudCounts> {
	const bad=()=>new Error('World cloud-source metadata missing or invalid; rebuild the merged octree');
	if(!value||typeof value!=='object')throw bad();
	const data=value as Record<string,unknown>;
	const kinds=data.kinds as Record<string,unknown>|undefined;
	// schema 4: some run names a foliage source (the API's world_build.source_manifest); 3: none does, field for field
	const schema4=data.schema===4;
	const kindsOk=!!kinds&&typeof kinds==='object'&&kinds.dense===DENSE_CLOUD&&
		(schema4?kinds.foliage===FOLIAGE_CLOUD&&Object.keys(kinds).length===2:Object.keys(kinds).length===1);
	if((data.schema!==3&&!schema4)||data.resolution!==mode||data.key!==key||data.field!=='UserData'||!kindsOk||!Array.isArray(data.runs)||data.runs.length!==ids.length||
		('overlap' in data&&!OWNERSHIP_RULES.includes(data.overlap as string)))throw bad();
	if(schema4&&!data.runs.some(r=>!!r&&typeof r==='object'&&'foliage_from' in r))throw bad();
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
		const ownership={...(owned?{owned_from:source}:{}),...foliageCounts(r,schema4,owned,mode,bad)};
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
