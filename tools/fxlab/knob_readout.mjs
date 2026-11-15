// Move's readout and value at knob positions, for tools/fxlab/fxlab.py
// accept-set. Each request is [knob key, u]: u in 0..1 picks one of the
// knob's dialable positions (dialPositions), spread along its travel.
//
//   node tools/fxlab/knob_readout.mjs '[["punch_amount", 0.37], ...]'
//   -> [["37 %", 0.3746, 490], ...]   (readout, value, position)
import { pathToFileURL } from 'node:url';
import { KNOBS, KNOB_UNITS, KNOB_CLICK, knobValue, formatKnob, stepKnob } from '../../src/knobs.mjs';

// The positions an acceptance Set may draw: ones LiveChopper's preview can
// be dialled to from the readout alone. The preview turns each knob to its
// bottom end once, then only whole clicks (no Shift), never to the top
// end: the knob then sits on the grid 0, 10, ... 1300 (the top is 1308, and
// a click down from it leaves the grid). A click keeps stepping while the
// readout doesn't change, so a readout two grid positions share is landed
// on at one going up and the other coming down: only positions the up-path
// from the bottom reaches and whose readout no other grid position shows
// are kept. Knob 5 (Decay) has no fine step, and from a fresh session's
// 50 ms it sits off this grid until it meets an end.
export function dialPositions(spec) {
    const count = new Map();
    for (let p = 0; p < KNOB_UNITS; p += KNOB_CLICK) {
        const t = formatKnob(spec, p);
        count.set(t, (count.get(t) || 0) + 1);
    }
    const out = [];
    for (let p = 0; p < KNOB_UNITS; p = stepKnob(spec, p, 1, false))
        if (count.get(formatKnob(spec, p)) === 1) out.push(p);
    return out;
}

export function readouts(req) {
    return req.map(([key, u]) => {
        const spec = KNOBS[key];
        if (!spec) throw new Error('unknown knob ' + key);
        const ok = dialPositions(spec);
        const pos = ok[Math.min(ok.length - 1, Math.floor(u * ok.length))];
        return [formatKnob(spec, pos), knobValue(spec, pos), pos];
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    console.log(JSON.stringify(readouts(JSON.parse(process.argv[2]))));
