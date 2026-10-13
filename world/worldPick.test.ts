import { describe, expect, it } from 'vitest';
import { isClick, mapLinks, pickGesture } from './worldPick';

describe('picking', () => {
	it('a click is a short press that barely moved; a drag or a long press is not', () => {
		const down = { button: 0, x: 100, y: 100, t: 0 };
		expect(isClick(down, { button: 0, x: 103, y: 102, t: 200 })).toBe(true);
		expect(isClick(down, { button: 0, x: 120, y: 100, t: 200 })).toBe(false);
		expect(isClick(down, { button: 0, x: 100, y: 100, t: 2000 })).toBe(false);
		expect(isClick(down, { button: 1, x: 100, y: 100, t: 100 })).toBe(false);
		expect(isClick(null, { button: 0, x: 100, y: 100, t: 100 })).toBe(false);
	});

	it('which click picks: middle anywhere, left in orbit, left at the centre while flying with the controls', () => {
		expect(pickGesture(1, 'fly', false)).toBe('pointer');
		expect(pickGesture(1, 'orbit', false)).toBe('pointer');
		expect(pickGesture(0, 'orbit', false)).toBe('pointer');
		// a left click in fly mode takes the controls -- not a pick
		expect(pickGesture(0, 'fly', false)).toBeNull();
		expect(pickGesture(0, 'fly', true)).toBe('centre');
		expect(pickGesture(2, 'orbit', false)).toBeNull();
	});

	it('links carry the point, and hillview the bearing it was seen along', () => {
		const l = mapLinks(49.781372, 14.170443, 197.73);
		expect(l.map((x) => x.label)).toEqual(['hillview', 'osm', 'mapy.com', 'osmap']);
		expect(l[0].href).toBe('https://hillview.cz/?lat=49.781372&lon=14.170443&zoom=16&bearing=197.7');
		expect(l[1].href).toContain('mlat=49.781372&mlon=14.170443');
		expect(mapLinks(50, 14, null)[0].href).not.toContain('bearing');
	});

});
