// src/knobs.mjs against a real Move: readouts recorded from its screen and
// raw values from sets saved on it (docs/PLAN.md, Sets 21-25 and screen
// sessions 2-4, 2026-11-09 and 10).
//
//   node tests/knobs_test.mjs        (exit code 1 on any failure)
import { KNOBS, KNOB_UNITS, knobValue, knobPos, formatKnob, formatTime, formatHz, formatSmall,
         spokenReadout, stepKnob } from '../src/knobs.mjs';

let failures = 0, checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) { failures++; console.log('FAIL: ' + msg); }
}
const near = (a, b, rel) => Math.abs(a - b) <= Math.abs(b) * rel;

// Readouts after each slow click from pos, n clicks (dir -1 down)
function sweep(name, pos, n, dir = 1, fine = false) {
  const out = [formatKnob(KNOBS[name], pos)];
  for (let i = 0; i < n; i++) {
    pos = stepKnob(KNOBS[name], pos, dir, fine);
    out.push(formatKnob(KNOBS[name], pos));
  }
  return out;
}
// Every value in want appears in got, in order (a fast turn on the Move skipped some)
function inOrder(got, want) {
  let i = 0;
  for (const w of want) { while (i < got.length && got[i] !== w) i++; if (i++ >= got.length) return false; }
  return true;
}
const BOTTOM = 0, TOP = KNOB_UNITS;

// ---- Envelope: slow sweeps, one value a click (screen session 2) ----
check(sweep('attack', BOTTOM, 25).join() === ['0.10 ms', '0.11 ms', '0.12 ms', '0.13 ms', '0.15 ms', '0.16 ms', '0.18 ms',
  '0.19 ms', '0.21 ms', '0.23 ms', '0.25 ms', '0.28 ms', '0.31 ms', '0.34 ms', '0.37 ms', '0.41 ms', '0.45 ms', '0.49 ms',
  '0.54 ms', '0.59 ms', '0.65 ms', '0.71 ms', '0.78 ms', '0.86 ms', '0.94 ms', '1.03 ms'].join(), 'Attack from the bottom: ' + sweep('attack', BOTTOM, 25));
{
  const a = sweep('attack', BOTTOM, 131);
  check(a.at(-1) === '20.0 s' && a.at(-2) === '18.6 s' && a.at(-3) === '16.9 s', 'Attack top: ' + a.slice(-3));
  check(a.includes('990 ms') === false && inOrder(a, ['708 ms', '777 ms', '853 ms', '937 ms', '1.03 s', '1.13 s']),
        'Attack goes from ms to s at 1 s: ' + a.slice(103, 110));
  check(new Set(a).size === 132, 'Attack: 131 clicks, every value new: ' + new Set(a).size);
}
check(sweep('hold', BOTTOM, 14).join() === ['1.00 ms', '1.09 ms', '1.18 ms', '1.29 ms', '1.40 ms', '1.52 ms', '1.66 ms', '1.80 ms',
  '1.96 ms', '2.13 ms', '2.32 ms', '2.52 ms', '2.74 ms', '2.98 ms', '3.25 ms'].join(), 'Hold from the bottom: ' + sweep('hold', BOTTOM, 14));
{
  const h = sweep('hold', BOTTOM, 131);
  check(h.slice(-5).join() === '43.6 s,47.4 s,51.6 s,56.1 s,Inf', 'Hold top: 56.1 s, then Inf: ' + h.slice(-5));
  check(inOrder(h, ['910 ms', '990 ms', '1.08 s', '1.17 s']), 'Hold 990 ms then 1.08 s');
}
{
  const d = sweep('decay', BOTTOM, 131);
  check(d[0] === '1.00 ms' && d.at(-2) === '56.1 s' && d.at(-1) === '60.0 s', 'Decay: 1.00 ms to 60.0 s, no Inf: ' + d.slice(-2));
  check(inOrder(d, ['86.3 ms', '93.9 ms', '102 ms', '111 ms']), 'Decay three figures across 100 ms');
}
check(formatKnob(KNOBS.hold, knobPos(KNOBS.hold, 0.55)) === '550 ms', 'a kit\'s Hold 0.55 shows 550 ms');
check(formatKnob(KNOBS.decay, knobPos(KNOBS.decay, 9.58943)) === '9.59 s', 'a kit\'s Decay 9.58943 shows 9.59 s');

// ---- Raw values Move saved (Sets 21, 23, 25) ----
const after = (name, from, clicks, fine) => knobValue(KNOBS[name], stepKnob(KNOBS[name], knobPos(KNOBS[name], from), clicks, fine));
check(near(after('attack', 0.0001, 1, true), 0.000105759, 1e-5), 'Set 23: Attack Shift click from 0.10 ms: ' + after('attack', 0.0001, 1, true));
check(near(after('hold', 0.8, 1, true), 0.806758, 1e-5), 'Set 23: Hold Shift click from 0.8 s: ' + after('hold', 0.8, 1, true));
check(near(after('frequency', 22000, -1, true), 21889.3, 1e-5), 'Set 25: Frequency Shift click down from 22 kHz: ' + after('frequency', 22000, -1, true));
check(near(after('resonance', 0, 1), 0.00688073, 1e-5) && near(after('resonance', 0, 10), 0.0688073, 1e-5),
      'Set 25: Resonance 1 and 10 clicks: ' + [after('resonance', 0, 1), after('resonance', 0, 10)]);
const linGain = db => Math.pow(10, db / 20);
check(near(linGain(after('peak', 0, 1)), 1.02135, 1e-5) && near(linGain(after('peak', 0, 10)), 1.23522, 1e-5),
      'Set 25: Peak Gain 1 and 10 clicks (stored linear): ' + [linGain(after('peak', 0, 1)), linGain(after('peak', 0, 10))]);
check(near(after('rate', 14080, 1, true), 14153.4, 1e-5), 'Set 24: 8-Bit Rate Shift click from Move\'s default: ' + after('rate', 14080, 1, true));

// ---- Filter and 8-Bit readouts (screen sessions 3 and 4) ----
check(inOrder(sweep('frequency', BOTTOM, 131), ['30.0 Hz', '33.2 Hz', '38.6 Hz', '47.2 Hz', '57.8 Hz', '74.4 Hz', '101 Hz', '130 Hz',
  '167 Hz', '276 Hz', '413 Hz', '651 Hz', '1.13 kHz', '1.97 kHz', '2.54 kHz', '2.67 kHz', '3.11 kHz', '4.21 kHz', '6.62 kHz',
  '10.4 kHz', '19.1 kHz', '22.0 kHz']), 'Frequency up from 30 Hz, as the Move showed it');
check(inOrder(sweep('frequency', TOP, 131, -1), ['22.0 kHz', '19.9 kHz', '16.3 kHz', '11.4 kHz', '8.44 kHz', '6.23 kHz', '4.38 kHz',
  '2.64 kHz', '1.86 kHz', '1.24 kHz', '872 Hz', '582 Hz', '501 Hz', '430 Hz', '370 Hz', '318 Hz', '260 Hz', '212 Hz', '183 Hz',
  '174 Hz', '149 Hz', '116 Hz', '85.7 Hz', '60.2 Hz', '36.3 Hz', '30.0 Hz']), 'Frequency down from 22 kHz, as the Move showed it');
check(sweep('resonance', BOTTOM, 10).join() === '0.0 %,0.7 %,1.4 %,2.1 %,2.8 %,3.4 %,4.1 %,4.8 %,5.5 %,6.2 %,6.9 %',
      'Resonance from 0: ' + sweep('resonance', BOTTOM, 10));
check(sweep('resonance', BOTTOM, 200).at(-1) === '90 %', 'Resonance tops out at 90 %');
check(sweep('peak', knobPos(KNOBS.peak, 0), 8).join() === '0.0 dB,0.2 dB,0.4 dB,0.6 dB,0.7 dB,0.9 dB,1.1 dB,1.3 dB,1.5 dB',
      'Peak Gain from 0 dB: ' + sweep('peak', knobPos(KNOBS.peak, 0), 8));
check(inOrder(sweep('peak', knobPos(KNOBS.peak, 0), 70, -1), ['0.0 dB', '-0.2 dB', '-0.9 dB', '-1.8 dB', '-2.9 dB', '-4.4 dB',
  '-6.1 dB', '-7.5 dB', '-8.8 dB', '-11 dB', '-12 dB']), 'Peak Gain down to -12 dB, as the Move showed it');
check(formatKnob(KNOBS.rate, knobPos(KNOBS.rate, 14080)) === '14.1 kHz', 'Move\'s 8-Bit default shows 14.1 kHz');
check(inOrder(sweep('rate', knobPos(KNOBS.rate, 14080), 131, -1), ['14.1 kHz', '13.4 kHz', '12.4 kHz', '11.4 kHz', '10.6 kHz',
  '9.53 kHz', '8.82 kHz', '7.95 kHz', '7.16 kHz', '6.45 kHz', '5.82 kHz', '5.52 kHz', '4.85 kHz', '4.15 kHz', '2.96 kHz',
  '2.34 kHz', '1.80 kHz', '1.43 kHz', '1.29 kHz', '1.25 kHz', '1.05 kHz', '1.00 kHz']), '8-Bit Rate down from the default, as the Move showed it');

// ---- Effect settings: sweeps from Move's default down to the bottom,
// then up to the top (screen session 3; fast turns there skipped values,
// so these are in order, not every one). A fast turn on Move can also land
// between clicks: Punch Release's 62.5 ms and Ring Mod Freq's 46.0 Hz fit
// no single 10-unit grid with their neighbours, so they are left out. ----
function downUp(name, from) {
  const k = KNOBS[name];
  let pos = knobPos(k, from);
  const out = [formatKnob(k, pos)];
  while (pos > 0) { pos = stepKnob(k, pos, -1); out.push(formatKnob(k, pos)); }
  while (pos < KNOB_UNITS) { pos = stepKnob(k, pos, 1); out.push(formatKnob(k, pos)); }
  return out;
}
const units = (list, u) => list.map(v => v + u);
const EFFECT_SWEEPS = [
  ['stretch_factor', 1, ['1.00', '1.02', '1.07', '1.16', '1.44', '1.93', '3.25', '4.48', '5.69', '6.92', '7.93', '8.11', '8.47', '9.41',
    '10.61', '11.88', '13.48', '15.69', '17.80', '20.00']],
  ['stretch_grain', 0.1, ['100 ms', '97.5 ms', '92.5 ms', '80.6 ms', '67.5 ms', '52.0 ms', '40.3 ms', '26.4 ms', '17.8 ms', '14.3 ms',
    '11.4 ms', '9.00 ms', '6.17 ms', '5.00 ms', '5.02 ms', '5.28 ms', '7.09 ms', '10.6 ms', '17.6 ms', '31.2 ms', '55.3 ms', '77.9 ms',
    '105 ms', '118 ms', '121 ms', '127 ms', '148 ms', '171 ms', '199 ms', '229 ms', '266 ms', '300 ms']],
  ['loop_offset', 0, units(['0.0', '0.4', '1.7', '4.0', '8.0', '12', '15', '16', '22', '30', '41', '52', '55', '56', '57', '66', '75',
    '84', '91', '94', '96', '100'], ' %')],
  ['loop_length', 0.3, ['300 ms', '294 ms', '277 ms', '250 ms', '215 ms', '178 ms', '126 ms', '98.6 ms', '75.0 ms', '59.6 ms', '55.0 ms',
    '52.7 ms', '44.3 ms', '30.3 ms', '17.9 ms', '10.9 ms', '10.0 ms', '10.7 ms', '12.9 ms', '18.3 ms', '27.9 ms', '45.1 ms', '65.4 ms',
    '84.5 ms', '90.5 ms', '93.5 ms', '99.8 ms', '106 ms', '117 ms', '142 ms', '158 ms', '184 ms', '227 ms', '263 ms', '285 ms', '291 ms',
    '302 ms', '332 ms', '376 ms', '500 ms']],
  ['pitch_amount', 0, units(['0.0', '-1.5', '-3.1', '-6.1', '-14', '-23', '-35', '-49', '-66', '-76', '-80', '-83', '-89', '-96', '-100',
    '-98', '-95', '-92', '-85', '-76', '-66', '-54', '-45', '-36', '-27', '-19', '-11', '-6.7', '-5.2', '-3.7', '-2.1', '2.4', '10', '18',
    '28', '39', '50', '59', '67', '73', '74', '76', '82', '88', '97', '100'], ' %')],
  ['pitch_decay', 0.3, ['300 ms', '287 ms', '241 ms', '199 ms', '147 ms', '98.5 ms', '62.8 ms', '37.5 ms', '21.0 ms', '10.3 ms', '5.94 ms',
    '5.01 ms', '5.00 ms', '5.02 ms', '5.31 ms', '7.45 ms', '18.9 ms', '50.2 ms', '86.2 ms', '138 ms', '179 ms', '207 ms', '217 ms',
    '228 ms', '273 ms', '366 ms', '572 ms', '844 ms', '1.16 s', '1.40 s', '1.55 s', '1.79 s', '2.00 s']],
  ['punch_amount', 0, units(['0.0', '0.8', '2.3', '4.6', '9.2', '15', '20', '26', '32', '38', '45', '48', '49', '54', '57', '64', '76',
    '83', '84', '88', '94', '100'], ' %')],
  ['punch_release', 0.12016, ['120 ms', '110 ms', '87.5 ms', '74.2 ms', '66.0 ms', '61.5 ms', '60.2 ms', '60.0 ms', '60.3 ms', '60.9 ms',
    '65.1 ms', '69.2 ms', '76.5 ms', '86.9 ms', '101 ms', '126 ms', '155 ms', '181 ms', '192 ms', '237 ms', '300 ms', '387 ms',
    '468 ms', '506 ms', '519 ms', '533 ms', '604 ms', '716 ms', '861 ms', '1.00 s']],
  ['crush_decay', 5, ['Off', '4.77 s', '3.76 s', '2.70 s', '1.76 s', '1.15 s', '822 ms', '536 ms', '487 ms', '403 ms', '289 ms', '188 ms',
    '135 ms', '112 ms', '107 ms', '102 ms', '80.1 ms', '52.2 ms', '29.5 ms', '18.4 ms', '15.2 ms', '14.5 ms', '13.8 ms', '10.0 ms',
    '11.0 ms', '15.3 ms', '22.4 ms', '36.1 ms', '58.0 ms', '93.3 ms', '136 ms', '200 ms', '230 ms', '265 ms', '388 ms', '595 ms', '957 ms',
    '1.54 s', '2.25 s', '2.36 s', '2.48 s', '2.85 s', '3.98 s', 'Off']],
  ['fm_amount', 0, units(['0.0', '0.1', '0.4', '1.3', '3.1', '5.9', '9.2', '12', '13', '17', '23', '32', '46', '56', '61', '63', '72', '83',
    '96', '100'], ' %')],
  ['fm_freq', 1000, ['1.00 kHz', '954 Hz', '792 Hz', '598 Hz', '431 Hz', '297 Hz', '204 Hz', '141 Hz', '101 Hz', '73.1 Hz', '52.7 Hz',
    '50.3 Hz', '45.8 Hz', '39.8 Hz', '31.5 Hz', '23.8 Hz', '17.2 Hz', '13.0 Hz', '10.0 Hz', '10.5 Hz', '11.5 Hz', '15.2 Hz', '22.1 Hz',
    '33.7 Hz', '56.3 Hz', '94.1 Hz', '150 Hz', '240 Hz', '289 Hz', '332 Hz', '365 Hz', '382 Hz', '483 Hz', '669 Hz', '1.23 kHz',
    '2.36 kHz', '4.50 kHz']],
  ['ring_amount', 0, units(['0.0', '2.3', '7.6', '11', '13', '17', '21', '25', '31', '35', '41', '45', '49', '54', '55', '56', '60', '67',
    '76', '87', '93', '99', '100'], ' %')],
  ['ring_freq', 1000, ['1.00 kHz', '899 Hz', '682 Hz', '423 Hz', '268 Hz', '162 Hz', '101 Hz', '59.8 Hz', '30.3 Hz', '14.0 Hz', '12.5 Hz',
    '9.80 Hz', '4.06 Hz', '1.31 Hz', '1.00 Hz', '1.05 Hz', '1.42 Hz', '3.68 Hz', '16.1 Hz', '79.6 Hz', '94.3 Hz', '111 Hz',
    '177 Hz', '291 Hz', '515 Hz', '909 Hz', '1.51 kHz', '2.30 kHz', '3.25 kHz', '4.31 kHz', '5.00 kHz']],
  ['sub_amount', 0, units(['0.0', '3.1', '9.2', '17', '25', '37', '49', '57', '63', '64', '66', '70', '78', '88', '96', '100'], ' %')],
  ['sub_freq', 60, ['60.0 Hz', '59.4 Hz', '57.5 Hz', '54.0 Hz', '49.6 Hz', '44.6 Hz', '39.7 Hz', '36.1 Hz', '31.8 Hz', '30.0 Hz', '30.6 Hz',
    '32.3 Hz', '34.8 Hz', '38.7 Hz', '43.5 Hz', '50.4 Hz', '59.1 Hz', '64.3 Hz', '66.4 Hz', '68.6 Hz', '72.3 Hz', '77.1 Hz', '83.9 Hz',
    '99.4 Hz', '110 Hz', '120 Hz']],
  ['noise_amount', 0, units(['0.0', '1.5', '4.6', '7.6', '12', '16', '19', '23', '28', '33', '37', '38', '41', '50', '58', '66', '71', '73',
    '74', '76', '82', '93', '100'], ' %')],
  ['noise_color', 10000, ['10.0 kHz', '9.82 kHz', '9.10 kHz', '8.41 kHz', '7.43 kHz', '6.22 kHz', '4.01 kHz', '2.39 kHz', '1.53 kHz',
    '1.33 kHz', '1.04 kHz', '699 Hz', '444 Hz', '242 Hz', '180 Hz', '181 Hz', '202 Hz', '285 Hz', '526 Hz', '960 Hz', '1.78 kHz',
    '2.43 kHz', '2.90 kHz', '3.20 kHz', '3.30 kHz', '3.51 kHz', '4.07 kHz', '5.72 kHz', '8.84 kHz', '10.5 kHz', '11.6 kHz', '11.8 kHz',
    '12.0 kHz', '13.3 kHz', '15.0 kHz']]
];
for (const [name, from, want] of EFFECT_SWEEPS) {
  const got = downUp(name, from);
  const missing = want.filter(w => !got.includes(w));
  check(inOrder(got, want), `${name}: Move's readouts, in order (not reached: ${missing.join(', ') || 'none; out of order'})`);
}
// Set 24: one Shift click on each setting from Move's default, as saved.
// Move took a few more fine steps than the readout needs on Stretch
// Factor, Grain, Loop Offset, Punch Release and FM Amount (unexplained,
// see PLAN.md); the model stops at the first changed readout.
for (const [name, from, want] of [['loop_length', 0.3, 0.300577], ['pitch_amount', 0, 0.0015291], ['pitch_decay', 0.3, 0.301281],
  ['punch_amount', 0, 0.000764526], ['crush_decay', 5, 4.9763], ['fm_freq', 1000, 1009.39], ['ring_amount', 0, 0.000764526],
  ['ring_freq', 1000, 1005.28], ['sub_amount', 0, 0.000764526], ['sub_freq', 60, 60.0636], ['noise_amount', 0, 0.000764526],
  ['noise_color', 10000, 10055.4]]) {
  const v = after(name, from, want < from ? -1 : 1, true);
  check(near(v, want, 1e-4), `Set 24: ${name} Shift click from ${from}: ${v}, Move saved ${want}`);
}
check(formatKnob(KNOBS.punch_release, knobPos(KNOBS.punch_release, 0.12016)) === '120 ms' &&
      formatKnob(KNOBS.crush_decay, KNOB_UNITS) === 'Off', 'Move\'s defaults read as on Move');

// ---- Formats ----
for (const [x, want] of [[0, '0.0'], [-0.02, '0.0'], [6.66, '6.7'], [-6.66, '-6.7'], [9.94, '9.9'], [9.96, '10'], [-14.2, '-14'], [100, '100']])
  check(formatSmall(x) === want, `formatSmall(${x}) = "${formatSmall(x)}", want "${want}"`);
for (const [s, want] of [[0.0001, '0.10 ms'], [0.00999, '9.99 ms'], [0.009996, '10.0 ms'], [0.0999, '99.9 ms'], [0.09996, '100 ms'],
                         [0.9994, '999 ms'], [0.9996, '1.00 s'], [20, '20.0 s'], [60, '60.0 s']])
  check(formatTime(s) === want, `formatTime(${s}) = "${formatTime(s)}", want "${want}"`);
for (const [hz, want] of [[1, '1.00 Hz'], [9.8, '9.80 Hz'], [30, '30.0 Hz'], [999.4, '999 Hz'], [999.6, '1.00 kHz'], [4500, '4.50 kHz'], [22000, '22.0 kHz']])
  check(formatHz(hz) === want, `formatHz(${hz}) = "${formatHz(hz)}", want "${want}"`);
for (const [t, want] of [['0.10 ms', '0.10 milliseconds'], ['1.03 s', '1.03 seconds'], ['22.0 kHz', '22.0 kilohertz'],
                         ['979 Hz', '979 hertz'], ['9.9 %', '9.9 percent'], ['-12 dB', '-12 decibels'], ['Inf', 'infinite']])
  check(spokenReadout(t) === want, `spokenReadout("${t}") = "${spokenReadout(t)}"`);

// ---- The model itself ----
for (const name of Object.keys(KNOBS)) {
  const k = KNOBS[name];
  check(knobValue(k, 0) === k.lo && Math.abs(knobValue(k, KNOB_UNITS) - k.hi) < 1e-9 * Math.abs(k.hi), `${name}: ends are the range`);
  for (const pos of [0, 1, 437.5, 1017.0947, 1307, KNOB_UNITS]) {
    const v = knobValue(k, pos);   /* p^5 near 0 is below double precision: compare values there */
    check(Math.abs(knobPos(k, v) - pos) < 1e-6 || Math.abs(knobValue(k, knobPos(k, v)) - v) <= 1e-12 * Math.abs(v),
          `${name}: knobPos inverts knobValue at ${pos}`);
  }
  check(knobPos(k, k.lo - 1) === 0 && knobPos(k, k.hi * 2 + 1) === KNOB_UNITS, `${name}: knobPos clamps`);
  check(stepKnob(k, KNOB_UNITS, 5) === KNOB_UNITS && stepKnob(k, 0, -5) === 0, `${name}: stops at both ends`);
}
check(stepKnob(KNOBS.attack, 0, 1) === 10 && stepKnob(KNOBS.attack, 0, 3) === 30, 'a click is 10 units');
check(stepKnob(KNOBS.hold, 1300, 1) === KNOB_UNITS, 'the last click is short');
check(near(10 / KNOB_UNITS, 0.00764526, 1e-6), 'a click is Move\'s 0.00764526 of the travel');

console.log(failures ? `${failures} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
