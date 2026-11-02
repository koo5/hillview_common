/**
 * The earth service, read straight from the browser (ea05): a channel names one release per layer,
 * and every tile is addressed by its release id, so a channel move never mixes two releases in one view.
 *
 * earth answers any origin and exposes the tile headers terrainTiles reads (X-Tile-Format, ...).
 * Credits come from earth too: its /attribution names each source, and the ortho release carries the
 * year ČÚZK's terms want shown ("ČÚZK, <year>").
 */

export type Releases = Partial<Record<'terrain' | 'ortho' | 'osm' | 'models' | 'names', string>>;
export type TerrainModel = 'surface' | 'bare';

/** a credit line's entry; `changes` is what was done to the source, where its licence asks it said (CC BY: IPR's) */
export type Credit = { text: string; url: string; licence: string; terms_url?: string; changes?: string };

/** a channel as read: everything the scene needs to address its layers and credit them, whichever are shown */
export type Earth = {
	base: string;
	releases: Releases;
	sources: Record<string, Source>;
	/** the ortho release's year, as ČÚZK's terms want it shown; null without an ortho release */
	orthoYear: string | null;
	/** the ortho release's coverage, [w, s, e, n] degrees: a tile wholly outside asks for no photo (terrainTiles) */
	orthoExtent: [number, number, number, number] | null;
};

/** what a scene draws of earth's layers: the terrain model always, the rest only where the channel has them */
export type EarthLayers = {
	/** terrainTiles' tileUrl: {z}/{x}/{y} */
	tileUrl: string;
	/** terrainTiles' orthoUrl, when the channel has an ortho release */
	orthoUrl?: string;
	/** OSM vector tiles (footprintTiles), when the channel has them */
	osmUrl?: string;
	/** the city models' manifest (cityModelTiles), when the channel has a models release */
	modelsUrl?: string;
	/** the names round a point (labelPool: the workbench's /terrain/labels answers alike), when it has names */
	namesUrl?: string;
};

type Source = { text: string; url: string; licence: string; terms_url?: string; changes?: string };

/** the terrain's sources, finest first: what a view of earth's terrain credits */
const TERRAIN_SOURCES = ['cuzk', 'glo30', 'etopo'];

function base(url: string): string {
	return url.replace(/\/+$/, '');
}

async function json<T>(f: typeof fetch, url: string, signal?: AbortSignal): Promise<T> {
	const r = await f(url, { signal });
	if (!r.ok) throw new Error(`earth: ${r.status} for ${url}`);
	return (await r.json()) as T;
}

/** the tile URLs of one set of releases (no requests) */
export function layerUrls(earth: string, releases: Releases, model: TerrainModel): EarthLayers {
	const b = base(earth);
	if (!releases.terrain) throw new Error('earth: the channel has no terrain release');
	return {
		tileUrl: `${b}/t/${releases.terrain}/terrain/${model}/{z}/{x}/{y}.q16`,
		orthoUrl: releases.ortho ? `${b}/t/${releases.ortho}/ortho/{z}/{x}/{y}.jpg` : undefined,
		osmUrl: releases.osm ? `${b}/t/${releases.osm}/osm/{z}/{x}/{y}.mvt` : undefined,
		modelsUrl: releases.models ? `${b}/t/${releases.models}/models/manifest.json` : undefined,
		namesUrl: releases.names ? `${b}/t/${releases.names}/names` : undefined
	};
}

/** the credit lines for the layers drawn: the terrain's sources, then the orthophoto with its year (`orthoYear` null
 * while it is not drawn), IPR's buildings and OpenStreetMap's names while they are */
export function credits(sources: Record<string, Source>, shown: { orthoYear: string | null; models?: boolean; names?: boolean }):
	Credit[] {
	const { orthoYear, models = false, names = false } = shown;
	const out: Credit[] = [];
	const source = (key: string) => {
		const s = sources[key];
		if (!s) throw new Error(`earth: /attribution has no ${key}`);
		return s;
	};
	for (const key of TERRAIN_SOURCES) {
		const s = source(key);
		out.push({ text: s.text, url: s.url, licence: s.licence });
	}
	if (orthoYear !== null) {
		const s = source('cuzk-ortho');
		out.push({ text: s.text.replace('{year}', orthoYear), url: s.url, licence: s.licence, terms_url: s.terms_url });
	}
	if (models) {
		const s = source('ipr');
		// CC BY asks the changes said: earth's attribution names them (I3S to GLB, the heights' datum)
		out.push({ text: s.text, url: s.url, licence: s.licence, terms_url: s.terms_url, changes: s.changes });
	}
	if (names) {
		const s = source('osm');
		out.push({ text: s.text, url: s.url, licence: s.licence });
	}
	return out;
}

/** a channel's releases, sources and the ortho year and coverage: three small cached reads */
export async function loadEarth(earth: string, channel: string, opts: { fetch?: typeof fetch; signal?: AbortSignal } = {}):
	Promise<Earth> {
	const f = opts.fetch ?? fetch;
	const b = base(earth);
	const [ch, attribution] = await Promise.all([
		json<{ releases: Releases }>(f, `${b}/channels/${encodeURIComponent(channel)}`, opts.signal),
		json<{ sources: Record<string, Source> }>(f, `${b}/attribution`, opts.signal)
	]);
	if (!ch.releases.terrain) throw new Error(`earth: channel ${channel} has no terrain release`);
	let orthoYear: string | null = null, orthoExtent: Earth['orthoExtent'] = null;
	if (ch.releases.ortho) {
		const r = await json<{ sources?: { year?: string; extent?: unknown } }>(f,
			`${b}/releases/${encodeURIComponent(ch.releases.ortho)}`, opts.signal);
		orthoYear = r.sources?.year ?? null;
		if (orthoYear === null) throw new Error(`earth: ortho release ${ch.releases.ortho} names no year (ČÚZK's terms need it shown)`);
		const x = r.sources?.extent;
		if (!Array.isArray(x) || x.length !== 4 || !x.every(Number.isFinite) || !(x[0] < x[2] && x[1] < x[3]))
			throw new Error(`earth: ortho release ${ch.releases.ortho} names no coverage box (sources.extent [w, s, e, n])`);
		orthoExtent = x as [number, number, number, number];
	}
	return { base: b, releases: ch.releases, sources: attribution.sources, orthoYear, orthoExtent };
}
