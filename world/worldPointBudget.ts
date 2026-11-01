/** Geometry is float32 XYZ + float32 RGB. This budget excludes browser/GPU
 * overhead and the separate decoded chunk cache. It is a view preference. */
export const WORLD_POINT_BUDGETS = [16,32,64,128,256,512,1024] as const;
export const DEFAULT_WORLD_POINT_MIB = 64;
export const worldBudgetPoints = (mib:number)=>Math.floor(mib*1024*1024/24);
export function worldPointMiB(raw:string|null):number {
 if(raw===null)return DEFAULT_WORLD_POINT_MIB;
 const value=Number(raw);
 if(!/^\d+$/.test(raw)||!WORLD_POINT_BUDGETS.includes(value as typeof WORLD_POINT_BUDGETS[number]))
  throw new Error('pointMiB must be one of '+WORLD_POINT_BUDGETS.join(', '));
 return value;
}

export const SAFE_WORLD_POINT_MIB = 16;
/** Recovery wins over both a pinned high URL and a saved preference. */
export function worldBudgetChoice(q:URLSearchParams,saved:string|null){
 const reset=q.get('safeBudget')==='1';
 return {mib:reset?SAFE_WORLD_POINT_MIB:worldPointMiB(q.get('pointMiB')??saved),reset};
}
export function safeWorldBudgetUrl(url:URL):string {
 const safe=new URL(url);safe.searchParams.set('pointMiB',String(SAFE_WORLD_POINT_MIB));safe.searchParams.set('safeBudget','1');return safe.href;
}
