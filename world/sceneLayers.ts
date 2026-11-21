/**
 * What a viewer chose to see in the scene (ea07): the terrain model, the orthophoto, IPR's city models, OpenStreetMap's
 * buildings, roads, walls and water (each its own layer, the operator 2026-11-21), which atlas
 * version, if any, its cameras, and the place names. Kept per viewer by the scene (localStorage); read back field by field, so a saved choice that no
 * longer applies (an atlas channel the app stopped offering, a value from an older page) falls back on its own
 * default and leaves the others as chosen.
 */
import type { TerrainModel } from './earth';
import { DEFAULT_WORLD_POINT_MIB, WORLD_POINT_BUDGETS } from './worldPointBudget';
import { initialPointSizing, readPointSizing, type PointSizing } from './pointSizing';

export type SceneLayers = {
	/** the terrain model: the ground everything stands on, drawn or not */
	terrain: TerrainModel;
	/** the terrain drawn (its tiles and the globe); hidden, its heights still carry the camera, the readout and OSM */
	terrainShown: boolean;
	ortho: boolean;
	/** IPR's 3D city models (Prague) */
	models: boolean;
	/** OpenStreetMap's buildings, roads, walls and water (earth's vector tiles): drawn wherever they are, city models or not */
	osmBuildings: boolean;
	osmRoads: boolean;
	osmWalls: boolean;
	osmWater: boolean;
	/** the atlas channel drawn, or null for none */
	atlas: string | null;
	/** the atlas's point budget, MiB, one of WORLD_POINT_BUDGETS (2026-11-05): a view preference, as the
	 * budget's own module says — a phone wants less, a workstation can hold more */
	atlasMiB: number;
	/** the atlas's points on screen by their distance: small near, larger far (pointSizing.ts; the operator, 2026-11-21) */
	atlasSizing: PointSizing;
	/** the atlas's cameras: every photograph's pose in its town, a colour per solve (off unless chosen) */
	cameras: boolean;
	/** place names (peaks, towers, places) over the scene */
	names: boolean;
	/** the height readout: the camera, the ground under it and where that came from, the last landing (2026-11-02) */
	readout: boolean;
};

/** bare ground first (the operator, 2026-11-01): the atlas's points stand on it, and the surface model's roofs and
 * canopy would stand in their way */
export function defaultLayers(channels: readonly string[], atlasMiB: number = DEFAULT_WORLD_POINT_MIB): SceneLayers {
	return { terrain: 'bare', terrainShown: true, ortho: true, models: true, osmBuildings: true, osmRoads: true, osmWalls: true,
		osmWater: true,
		atlas: channels[0] ?? null, atlasMiB, atlasSizing: initialPointSizing(), cameras: false, names: true, readout: false };
}

/**
 * What the ground is built from: the terrain model's tiles and, when chosen, the aerial photo. The terrain's
 * visibility is not read: hiding it only stops its drawing, where building the ground again would read every
 * terrain tile again and leave the camera, the readout and OSM without heights until they are back. So the photo
 * stays loaded while the terrain is hidden; it is neither drawn nor credited then.
 */
export function groundSources(layers: Pick<SceneLayers, 'ortho'>, urls: { tileUrl: string; orthoUrl?: string } | null):
	{ tileUrl?: string; orthoUrl?: string } {
	return { tileUrl: urls?.tileUrl, orthoUrl: layers.ortho ? urls?.orthoUrl : undefined };
}

/** `atlasMiB` is the host's default budget, for a viewer who has not chosen one */
export function readLayers(saved: string | null, channels: readonly string[], atlasMiB: number = DEFAULT_WORLD_POINT_MIB): SceneLayers {
	const d = defaultLayers(channels, atlasMiB);
	let v: Partial<Record<keyof SceneLayers, unknown>> = {};
	try {
		const parsed: unknown = saved === null ? null : JSON.parse(saved);
		if (parsed && typeof parsed === 'object') v = parsed;
	} catch {
		/* not ours: the defaults */
	}
	return {
		terrain: v.terrain === 'bare' || v.terrain === 'surface' ? v.terrain : d.terrain,
		terrainShown: typeof v.terrainShown === 'boolean' ? v.terrainShown : d.terrainShown,
		ortho: typeof v.ortho === 'boolean' ? v.ortho : d.ortho,
		models: typeof v.models === 'boolean' ? v.models : d.models,
		osmBuildings: typeof v.osmBuildings === 'boolean' ? v.osmBuildings : d.osmBuildings,
		osmRoads: typeof v.osmRoads === 'boolean' ? v.osmRoads : d.osmRoads,
		osmWalls: typeof v.osmWalls === 'boolean' ? v.osmWalls : d.osmWalls,
		osmWater: typeof v.osmWater === 'boolean' ? v.osmWater : d.osmWater,
		atlas: v.atlas === null || (typeof v.atlas === 'string' && channels.includes(v.atlas)) ? v.atlas : d.atlas,
		atlasMiB: (WORLD_POINT_BUDGETS as readonly unknown[]).includes(v.atlasMiB) ? (v.atlasMiB as number) : d.atlasMiB,
		atlasSizing: readPointSizing(v.atlasSizing),
		cameras: typeof v.cameras === 'boolean' ? v.cameras : d.cameras,
		names: typeof v.names === 'boolean' ? v.names : d.names,
		readout: typeof v.readout === 'boolean' ? v.readout : d.readout
	};
}
