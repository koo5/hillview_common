/**
 * "What is that?" in the 3D world (2026-10-03): a click on the picture reads the depth the frame
 * was drawn with at that pixel -- whatever was drawn there, terrain, a roof or a point cloud --
 * and gives the place: its coordinates, its distance, and links to open it on a map. The
 * operator: "like hillview frontend does with terrain overlay" (OpenSeadragonViewer's pick card).
 *
 * The gestures, because a left click in fly mode is already "take the controls":
 *   - the middle button, in either mode;
 *   - a left click in orbit mode (a left DRAG still orbits);
 *   - a left click while flying with the controls taken: the centre of the view.
 * A press that moves more than CLICK_SLOP_PX or lasts over CLICK_MAX_MS is a drag, not a pick.
 */

export const CLICK_SLOP_PX = 5;
export const CLICK_MAX_MS = 600;

export type Press = { button: number; x: number; y: number; t: number };

/** is this release the end of a click (not a drag, not a long press) of the pressed button? */
export function isClick(down: Press | null, up: Press): boolean {
	return !!down && down.button === up.button && Math.hypot(up.x - down.x, up.y - down.y) <= CLICK_SLOP_PX &&
		up.t - down.t <= CLICK_MAX_MS;
}

/** what a click asks for: a pick at the pointer, at the centre of the view, or nothing */
export function pickGesture(button: number, mode: 'orbit' | 'fly', locked: boolean): 'pointer' | 'centre' | null {
	if (button === 1) return locked ? 'centre' : 'pointer';
	if (button !== 0) return null;
	if (mode === 'orbit') return 'pointer';
	return locked ? 'centre' : null;
}

export type MapLink = { label: string; href: string; title: string };

/** where to open a picked point; `bearing` (from the camera to it) turns hillview's map the same way */
export function mapLinks(lat: number, lon: number, bearing: number | null, zoom = 16): MapLink[] {
	const la = lat.toFixed(6), lo = lon.toFixed(6);
	const b = bearing === null ? '' : `&bearing=${(Math.round(bearing * 10) / 10).toFixed(1)}`;
	return [
		{ label: 'hillview', href: `https://hillview.cz/?lat=${la}&lon=${lo}&zoom=${zoom}${b}`,
			title: 'the photos around this point, the map turned the way you look' },
		{ label: 'osm', href: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=${zoom}/${la}/${lo}`,
			title: 'OpenStreetMap, with a marker' },
		{ label: 'mapy.com', href: `https://mapy.com/en/turisticka?x=${lo}&y=${la}&z=${zoom}&source=coor&id=${lo}%2C${la}`,
			title: 'mapy.com, the tourist map, with a marker' },
		{ label: 'osmap', href: `https://osmap.vfosnar.cz/#base=cuzk&map=${zoom}/${lat.toFixed(5)}/${lon.toFixed(5)}`,
			title: 'the ČÚZK base map' }
	];
}
