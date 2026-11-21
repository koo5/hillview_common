/**
 * Mapbox Vector Tiles (specification 2.1), read without a dependency: the protobuf wire format, a layer's keys and
 * values, a feature's tags and its geometry commands. Enough for earth's OpenStreetMap tiles (its `osm` release:
 * building polygons, road and water lines, their OSM tags).
 *
 * mvtOsm turns one tile into what the scene draws of it, in latitude and longitude: its `building` layer's footprints,
 * its `road` and `wall` layers' lines and its `water` layer's waterways and shores. A tile carries every building that touches it
 * or its buffer whole, so a building near a tile's edge is in two or more tiles; each is kept only by the tile that
 * holds its centroid, which is the same answer in every tile. A line is cut at the tile's own edge instead
 * (clipToTile), so each metre of it is drawn by one tile.
 */

export type MvtValue = string | number | boolean;
export type MvtFeature = { id?: number; type: number; tags: Record<string, MvtValue>; geometry: [number, number][][] };
export type MvtLayer = { name: string; extent: number; features: MvtFeature[] };

class Reader {
	pos: number;
	constructor(private readonly b: Uint8Array, start = 0, readonly end = b.length) {
		this.pos = start;
	}
	get done() {
		return this.pos >= this.end;
	}
	/** an unsigned varint, exact up to 2^53 (OSM ids are far below) */
	varint(): number {
		let v = 0, mul = 1, x: number;
		do {
			if (this.pos >= this.end) throw new Error('mvt: a varint runs past its message');
			x = this.b[this.pos++];
			v += (x & 0x7f) * mul;
			mul *= 128;
		} while (x & 0x80);
		return v;
	}
	bytes(): Reader {
		const n = this.varint();
		if (this.pos + n > this.end) throw new Error('mvt: a field runs past its message');
		const r = new Reader(this.b, this.pos, this.pos + n);
		this.pos += n;
		return r;
	}
	string(): string {
		const r = this.bytes();
		return new TextDecoder().decode(this.b.subarray(r.pos, r.end));
	}
	fixed(n: 4 | 8): DataView {
		if (this.pos + n > this.end) throw new Error('mvt: a fixed field runs past its message');
		const v = new DataView(this.b.buffer, this.b.byteOffset + this.pos, n);
		this.pos += n;
		return v;
	}
	/** the next field's number and wire type */
	key(): [number, number] {
		const k = this.varint();
		return [Math.floor(k / 8), k % 8];
	}
	skip(wire: number) {
		if (wire === 0) this.varint();
		else if (wire === 1) this.fixed(8);
		else if (wire === 2) this.bytes();
		else if (wire === 5) this.fixed(4);
		else throw new Error(`mvt: wire type ${wire} is not one a tile uses`);
	}
	packed(): number[] {
		const r = this.bytes(), out: number[] = [];
		while (!r.done) out.push(r.varint());
		return out;
	}
}

const zigzag = (n: number) => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function readValue(r: Reader): MvtValue {
	let out: MvtValue | undefined;
	while (!r.done) {
		const [f, w] = r.key();
		if (f === 1 && w === 2) out = r.string();
		else if (f === 2 && w === 5) out = r.fixed(4).getFloat32(0, true);
		else if (f === 3 && w === 1) out = r.fixed(8).getFloat64(0, true);
		else if ((f === 4 || f === 5) && w === 0) out = r.varint();
		else if (f === 6 && w === 0) out = zigzag(r.varint());
		else if (f === 7 && w === 0) out = r.varint() !== 0;
		else r.skip(w);
	}
	if (out === undefined) throw new Error('mvt: a value with no type');
	return out;
}

/** a feature's geometry commands as its rings or lines, in tile units (MoveTo starts one, ClosePath ends a ring) */
function readGeometry(cmds: number[]): [number, number][][] {
	const out: [number, number][][] = [];
	let x = 0, y = 0, i = 0, current: [number, number][] | null = null;
	while (i < cmds.length) {
		const id = cmds[i] & 7, count = cmds[i] >>> 3;
		i++;
		if (id === 1 || id === 2) {
			if (i + 2 * count > cmds.length) throw new Error('mvt: a geometry command runs past its parameters');
			for (let k = 0; k < count; k++) {
				x += zigzag(cmds[i++]);
				y += zigzag(cmds[i++]);
				if (id === 1) {
					current = [];
					out.push(current);
				}
				if (!current) throw new Error('mvt: LineTo before MoveTo');
				current.push([x, y]);
			}
		} else if (id === 7) {
			if (current && current.length) current.push([current[0][0], current[0][1]]);
		} else throw new Error(`mvt: geometry command ${id} is not in the specification`);
	}
	return out;
}

/** every layer of a tile (gzip already undone: earth serves tiles plain) */
export function decodeMvt(bytes: Uint8Array): MvtLayer[] {
	const tile = new Reader(bytes), layers: MvtLayer[] = [];
	while (!tile.done) {
		const [f, w] = tile.key();
		if (f !== 3 || w !== 2) { tile.skip(w); continue; }
		const r = tile.bytes();
		let name = '', extent = 4096;
		const keys: string[] = [], values: MvtValue[] = [], raw: Reader[] = [];
		while (!r.done) {
			const [lf, lw] = r.key();
			if (lf === 1 && lw === 2) name = r.string();
			else if (lf === 2 && lw === 2) raw.push(r.bytes());
			else if (lf === 3 && lw === 2) keys.push(r.string());
			else if (lf === 4 && lw === 2) values.push(readValue(r.bytes()));
			else if (lf === 5 && lw === 0) extent = r.varint();
			else r.skip(lw);
		}
		const features = raw.map((fr): MvtFeature => {
			let id: number | undefined, type = 0, tags: number[] = [], geometry: number[] = [];
			while (!fr.done) {
				const [ff, fw] = fr.key();
				if (ff === 1 && fw === 0) id = fr.varint();
				else if (ff === 2 && fw === 2) tags = fr.packed();
				else if (ff === 3 && fw === 0) type = fr.varint();
				else if (ff === 4 && fw === 2) geometry = fr.packed();
				else fr.skip(fw);
			}
			if (tags.length % 2) throw new Error(`mvt: layer ${name} has a feature with an odd tag list`);
			const props: Record<string, MvtValue> = {};
			for (let k = 0; k < tags.length; k += 2) {
				if (tags[k] >= keys.length || tags[k + 1] >= values.length) throw new Error(`mvt: layer ${name}: a tag out of range`);
				props[keys[tags[k]]] = values[tags[k + 1]];
			}
			return { id, type, tags: props, geometry: readGeometry(geometry) };
		});
		layers.push({ name, extent, features });
	}
	return layers;
}

/** one footprint: its OSM id, its outline and its courtyards (inner rings), each closed, in latitude and longitude, and
 * its height: OSM's, else its floors at LEVEL_M, else DEFAULT_BUILDING_M (height_source says which) */
export type FlatBuilding = { id: number | undefined; ring: [number, number][]; holes: [number, number][][];
	height_m: number; height_source: 'height' | 'levels' | 'default' };

/** a line in latitude and longitude: a road, a wall, a waterway, or a stretch of a lake's or river's shore */
export type FlatLine = [number, number][];

/** what the scene draws of one vector tile */
export type OsmTile = { buildings: FlatBuilding[]; roads: FlatLine[]; walls: FlatLine[]; water: FlatLine[] };

/** a storey's height, for a building whose OSM tags give only `building:levels` */
export const LEVEL_M = 3;
/** a building whose OSM tags give neither a height nor floors: one storey (the operator, 2026-11-21) */
export const DEFAULT_BUILDING_M = 3;

const number = (v: MvtValue | undefined): number | null => {
	if (typeof v === 'number') return Number.isFinite(v) ? v : null;
	if (typeof v !== 'string') return null;
	const m = /^\s*(\d+(?:[.,]\d+)?)\s*(m)?\s*$/.exec(v);
	return m ? Number(m[1].replace(',', '.')) : null;
};

/** twice the signed area in tile units (the specification's surveyor's formula): positive for an exterior ring */
const area2 = (ring: [number, number][]) => {
	let s = 0;
	for (let i = 0; i + 1 < ring.length; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
	return s;
};

/** tile units of a tile at z/x/y, extent `e`, to latitude and longitude */
function degrees(z: number, x: number, y: number, e: number): (p: [number, number]) => [number, number] {
	const n = 2 ** z;
	return ([px, py]) => [(Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + py / e)) / n))) * 180) / Math.PI,
		((x + px / e) / n) * 360 - 180];
}

/**
 * One tile's buildings (its `building` layer's polygons): each exterior ring a footprint, with the interior rings that
 * follow it as its courtyards. A footprint is drawn as walls round its outline and round each courtyard, up to one
 * roof height. Kept only where its centroid (the mean of its outline's vertices, in tile units) lies in this tile, so
 * a building in several tiles' buffers is drawn once.
 */
export function mvtBuildings(layers: MvtLayer[], z: number, x: number, y: number): FlatBuilding[] {
	const layer = layers.find((l) => l.name === 'building');
	if (!layer) return [];
	const e = layer.extent, at = degrees(z, x, y, e);
	const out: FlatBuilding[] = [];
	for (const f of layer.features) {
		if (f.type !== 3) continue;
		const h = number(f.tags.height), levels = number(f.tags['building:levels']);
		const height = h !== null && h > 0 ? { height_m: h, height_source: 'height' as const }
			: levels !== null && levels > 0 ? { height_m: levels * LEVEL_M, height_source: 'levels' as const }
				: { height_m: DEFAULT_BUILDING_M, height_source: 'default' as const };
		const id = typeof f.tags.osm_id === 'number' ? f.tags.osm_id : f.id;
		// the building the interior rings that follow belong to; null while its outline is another tile's
		let kept: FlatBuilding | null = null;
		for (const ring of f.geometry) {
			if (ring.length < 4) continue;
			const a = area2(ring);
			if (a < 0) {
				kept?.holes.push(ring.map(at));
				continue;
			}
			kept = null;
			if (a === 0) continue;
			// the ring is closed: its last vertex repeats the first, which the mean leaves out
			let cx = 0, cy = 0;
			for (let i = 0; i + 1 < ring.length; i++) { cx += ring[i][0]; cy += ring[i][1]; }
			cx /= ring.length - 1; cy /= ring.length - 1;
			if (cx < 0 || cx >= e || cy < 0 || cy >= e) continue;
			kept = { id, ring: ring.map(at), holes: [], ...height };
			out.push(kept);
		}
	}
	return out;
}

/**
 * A segment's part inside the tile's own square (Liang-Barsky), or null. Half-open, as tiles share their edges: a
 * segment lying along the left or top edge is this tile's, one along the right or bottom edge the neighbour's.
 */
function clipSegment(p: [number, number], q: [number, number], e: number): [[number, number], [number, number]] | null {
	const dx = q[0] - p[0], dy = q[1] - p[1];
	let t0 = 0, t1 = 1;
	for (const [k, d, strict] of [[-dx, p[0], false], [dx, e - p[0], true], [-dy, p[1], false], [dy, e - p[1], true]] as const) {
		if (k === 0) {
			if (d < 0 || (strict && d === 0)) return null;
			continue;
		}
		const r = d / k;
		if (k < 0) { if (r > t1) return null; if (r > t0) t0 = r; }
		else { if (r < t0) return null; if (r < t1) t1 = r; }
	}
	if (t1 <= t0) return null;
	return [[p[0] + t0 * dx, p[1] + t0 * dy], [p[0] + t1 * dx, p[1] + t1 * dy]];
}

/** a line's parts inside the tile's own square [0, e]^2, in tile units: cut where it leaves and enters again */
export function clipToTile(line: [number, number][], e: number): [number, number][][] {
	const out: [number, number][][] = [];
	let cur: [number, number][] | null = null;
	for (let i = 0; i + 1 < line.length; i++) {
		const s = clipSegment(line[i], line[i + 1], e);
		if (!s) { cur = null; continue; }
		const last = cur?.[cur.length - 1];
		if (cur && last && last[0] === s[0][0] && last[1] === s[0][1]) cur.push(s[1]);
		else { cur = [s[0], s[1]]; out.push(cur); }
	}
	return out;
}

/** a layer's lines and every ring of its polygons (a shore), each cut to the tile's own square, in degrees */
export function mvtLines(layers: MvtLayer[], name: string, z: number, x: number, y: number): FlatLine[] {
	const layer = layers.find((l) => l.name === name);
	if (!layer) return [];
	const at = degrees(z, x, y, layer.extent);
	const out: FlatLine[] = [];
	for (const f of layer.features) {
		if (f.type !== 2 && f.type !== 3) continue;
		for (const part of f.geometry) for (const piece of clipToTile(part, layer.extent)) out.push(piece.map(at));
	}
	return out;
}

/** one tile, as the scene draws it: buildings, roads, walls (earth's `wall`: retaining walls), water */
export function mvtOsm(layers: MvtLayer[], z: number, x: number, y: number): OsmTile {
	return { buildings: mvtBuildings(layers, z, x, y), roads: mvtLines(layers, 'road', z, x, y),
		walls: mvtLines(layers, 'wall', z, x, y), water: mvtLines(layers, 'water', z, x, y) };
}
