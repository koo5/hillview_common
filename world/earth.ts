/**
 * The earth service, read straight from the browser (ea05): a channel names one release per layer,
 * and every tile is addressed by its release id, so a channel move never mixes two releases in one view.
 *
 * earth answers any origin and exposes the tile headers terrainTiles reads (X-Tile-Format, ...).
 * Credits come from earth too: its /attribution names each source, and the ortho release carries the
 * year ČÚZK's terms want shown ("ČÚZK, <year>").
 */

export type Releases = Partial<Record<'terrain' | 'ortho' | 'osm' | 'models', string>>;
export type TerrainModel = 'surface' | 'bare';

export type Credit = { text: string; url: string; licence: string; terms_url?: string };

export type EarthLayers = {
	releases: Releases;
	/** terrainTiles' tileUrl: {z}/{x}/{y} */
	tileUrl: string;
	/** terrainTiles' orthoUrl, when the channel has an ortho release */
	orthoUrl?: string;
	/** OSM vector tiles (footprintTiles), when the channel has them */
	osmUrl?: string;
	/** what a view drawing these layers names, in that order */
	credits: Credit[];
};

type Source = { text: string; url: string; licence: string; terms_url?: string };

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
export function layerUrls(earth: string, releases: Releases, model: TerrainModel = 'surface'):
	Pick<EarthLayers, 'tileUrl' | 'orthoUrl' | 'osmUrl'> {
	const b = base(earth);
	if (!releases.terrain) throw new Error('earth: the channel has no terrain release');
	return {
		tileUrl: `${b}/t/${releases.terrain}/terrain/${model}/{z}/{x}/{y}.q16`,
		orthoUrl: releases.ortho ? `${b}/t/${releases.ortho}/ortho/{z}/{x}/{y}.jpg` : undefined,
		osmUrl: releases.osm ? `${b}/t/${releases.osm}/osm/{z}/{x}/{y}.mvt` : undefined
	};
}

/** the credit lines for the layers drawn: the terrain's sources, then the orthophoto with its year */
export function credits(sources: Record<string, Source>, orthoYear: string | null): Credit[] {
	const out: Credit[] = [];
	for (const key of TERRAIN_SOURCES) {
		const s = sources[key];
		if (!s) throw new Error(`earth: /attribution has no ${key}`);
		out.push({ text: s.text, url: s.url, licence: s.licence });
	}
	if (orthoYear !== null) {
		const s = sources['cuzk-ortho'];
		if (!s) throw new Error('earth: /attribution has no cuzk-ortho');
		out.push({ text: s.text.replace('{year}', orthoYear), url: s.url, licence: s.licence, terms_url: s.terms_url });
	}
	return out;
}

/** a channel's releases, tile URLs and credits: three small cached reads */
export async function loadEarth(earth: string, channel: string, opts: { model?: TerrainModel; fetch?: typeof fetch;
	signal?: AbortSignal } = {}): Promise<EarthLayers> {
	const f = opts.fetch ?? fetch;
	const b = base(earth);
	const [ch, attribution] = await Promise.all([
		json<{ releases: Releases }>(f, `${b}/channels/${encodeURIComponent(channel)}`, opts.signal),
		json<{ sources: Record<string, Source> }>(f, `${b}/attribution`, opts.signal)
	]);
	let year: string | null = null;
	if (ch.releases.ortho) {
		const r = await json<{ sources?: { year?: string } }>(f, `${b}/releases/${encodeURIComponent(ch.releases.ortho)}`, opts.signal);
		year = r.sources?.year ?? null;
		if (year === null) throw new Error(`earth: ortho release ${ch.releases.ortho} names no year (ČÚZK's terms need it shown)`);
	}
	return { releases: ch.releases, ...layerUrls(b, ch.releases, opts.model), credits: credits(attribution.sources, year) };
}
