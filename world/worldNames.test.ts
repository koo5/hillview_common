import { describe, expect, it } from 'vitest';
import { pruneVerdicts } from './worldNames';
import type { Judged, Projected } from './worldLabels';

const judged: Judged = { seen: true, own: 10, lift: null };
const named = (id: string) => ({ n: { id } }) as unknown as Projected;

describe('the verdicts kept (ea15)', () => {
	it('past the cap, keep those of the names projected now and of the verdict coming in; never empty the map', () => {
		const vis = new Map(['a', 'b', 'c', 'd'].map((id) => [id, judged]));
		pruneVerdicts(vis, [[named('a'), named('b')], [named('b'), named('z')]], 3);
		expect([...vis.keys()]).toEqual(['a', 'b']);
		// within the cap nothing goes, on screen or not
		const few = new Map(['a', 'b'].map((id) => [id, judged]));
		pruneVerdicts(few, [[]], 3);
		expect([...few.keys()]).toEqual(['a', 'b']);
	});
});
