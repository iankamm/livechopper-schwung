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
  for (const pos of [0, 1, 437.5, 1017.0947, 1307, KNOB_UNITS])
    check(Math.abs(knobPos(k, knobValue(k, pos)) - pos) < 1e-6, `${name}: knobPos inverts knobValue at ${pos}`);
  check(knobPos(k, k.lo - 1) === 0 && knobPos(k, k.hi * 2 + 1) === KNOB_UNITS, `${name}: knobPos clamps`);
  check(stepKnob(k, KNOB_UNITS, 5) === KNOB_UNITS && stepKnob(k, 0, -5) === 0, `${name}: stops at both ends`);
}
check(stepKnob(KNOBS.attack, 0, 1) === 10 && stepKnob(KNOBS.attack, 0, 3) === 30, 'a click is 10 units');
check(stepKnob(KNOBS.hold, 1300, 1) === KNOB_UNITS, 'the last click is short');
check(near(10 / KNOB_UNITS, 0.00764526, 1e-6), 'a click is Move\'s 0.00764526 of the travel');

console.log(failures ? `${failures} FAILED` : `all ${checks} checks passed`);
process.exit(failures ? 1 : 0);
