import type {CopcNode} from './copcSource';

/** Rank requested detail across depths, after the initial one-node overview.
 * A shallow distant node must not precede a deeper nearby surface simply because
 * of its octree level. Keep coarse off-screen coverage last, never as a download
 * barrier in front of visible detail. Eligibility/density thresholds are unchanged.
 */
export function planWorldView(nodes:CopcNode[],
 measure:(node:CopcNode)=>{visible:boolean;distance:number;pixels:number}) {
 const ranked=nodes.map((node,index)=>({node,index,...measure(node)}))
  .filter(r=>r.node.depth<=1||(r.visible&&r.pixels>=64));
 ranked.sort((a,b)=>Number(b.visible)-Number(a.visible)||a.distance-b.distance||a.node.depth-b.node.depth||a.index-b.index);
 return ranked.map(r=>r.node);
}


/** Publish nearby detail before grouping the small trailing blocks into bulk
 * geometry updates. Raw point and decoder/concurrency bounds stay unchanged. */
export function worldBatch(priorityPoints:number,hasCloud:boolean){
 return {maxNodes:hasCloud?(priorityPoints<200000?12:64):1,
  rawPoints:Math.max(400000,Math.min(2000000,priorityPoints*2)),
  separateNear:priorityPoints<200000};
}
