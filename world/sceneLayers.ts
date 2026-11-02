/**
 * What a viewer chose to see in the scene (ea07): the terrain model, the orthophoto, IPR's buildings, which atlas
 * version, if any, and the place names. Kept per viewer by the scene (localStorage); read back field by field, so a saved choice that no
 * longer applies (an atlas channel the app stopped offering, a value from an older page) falls back on its own
 * default and leaves the others as chosen.
 */
import type { TerrainModel } from './earth';

export type SceneLayers = {
	terrain: TerrainModel;
	ortho: boolean;
	buildings: boolean;
	/** the atlas channel drawn, or null for none */
	atlas: string | null;
	/** place names (peaks, towers, places) over the scene */
	names: boolean;
	/** the height readout: the camera, the ground under it and where that came from, the last landing (2026-11-02) */
	readout: boolean;
};

/** bare ground first (the operator, 2026-11-01): the atlas's points stand on it, and the surface model's roofs and
 * canopy would stand in their way */
export function defaultLayers(channels: readonly string[]): SceneLayers {
	return { terrain: 'bare', ortho: true, buildings: true, atlas: channels[0] ?? null, names: true, readout: false };
}

export function readLayers(saved: string | null, channels: readonly string[]): SceneLayers {
	const d = defaultLayers(channels);
	let v: Partial<Record<keyof SceneLayers, unknown>> = {};
	try {
		const parsed: unknown = saved === null ? null : JSON.parse(saved);
		if (parsed && typeof parsed === 'object') v = parsed;
	} catch {
		/* not ours: the defaults */
	}
	return {
		terrain: v.terrain === 'bare' || v.terrain === 'surface' ? v.terrain : d.terrain,
		ortho: typeof v.ortho === 'boolean' ? v.ortho : d.ortho,
		buildings: typeof v.buildings === 'boolean' ? v.buildings : d.buildings,
		atlas: v.atlas === null || (typeof v.atlas === 'string' && channels.includes(v.atlas)) ? v.atlas : d.atlas,
		names: typeof v.names === 'boolean' ? v.names : d.names,
		readout: typeof v.readout === 'boolean' ? v.readout : d.readout
	};
}
