// Move's readout and value at knob positions, for tools/fxlab/fxlab.py
// accept-set. Each request is [knob key, u]: u in 0..1 picks a whole
// number of clicks along the knob's travel.
//
//   node tools/fxlab/knob_readout.mjs '[["punch_amount", 0.37], ...]'
//   -> [["37 %", 0.3746, 490], ...]   (readout, value, position)
import { KNOBS, KNOB_UNITS, KNOB_CLICK, knobValue, formatKnob } from '../../src/knobs.mjs';

const clicks = Math.ceil(KNOB_UNITS / KNOB_CLICK);
const out = JSON.parse(process.argv[2]).map(([key, u]) => {
    const spec = KNOBS[key];
    if (!spec) throw new Error('unknown knob ' + key);
    const pos = Math.min(KNOB_UNITS, Math.round(u * clicks) * KNOB_CLICK);
    return [formatKnob(spec, pos), knobValue(spec, pos), pos];
});
console.log(JSON.stringify(out));
