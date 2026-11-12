/*
 * Move's knob model, measured on a Move (docs/PLAN.md, "Every knob follows
 * Move"): every knob that mirrors a Move control moves, steps and reads out
 * the way Move's own does.
 *
 * A knob is a position from 0 to KNOB_UNITS. A click moves it KNOB_CLICK
 * units and a Shift click 1, clamped at the ends (so the last click is
 * short); 131 clicks end to end. Each setting maps the position onto its
 * range with its own curve. Move keeps stepping until the value on screen
 * changes, so a click always shows a new value. Positions need not sit on
 * the grid: Move's own defaults often don't (8-Bit Rate's 14.08 kHz is at
 * 1017.1), and steps keep that offset.
 */

export var KNOB_UNITS = 1308;   /* a click is 0.00764526 of the travel */
export var KNOB_CLICK = 10;

/* curve: "log" = lo * (hi / lo)^p, or n = lo + (hi - lo) * p^n.
 * unit picks the readout: "s" (ms / s), "Hz" (Hz / kHz), "%" (of 0..1,
 * shown x100), "dB", "x" (two decimals, no unit). top: what the readout
 * says at the very top. Ranges and curves from Move sets (PLAN.md "Knob
 * curves"); the effects' settings are in the preset's units. */
export var KNOBS = {
    attack:    { lo: 0.0001, hi: 20, curve: "log", unit: "s" },
    hold:      { lo: 0.001, hi: 60, curve: "log", unit: "s", top: "Inf" },
    decay:     { lo: 0.001, hi: 60, curve: "log", unit: "s" },
    rate:      { lo: 1000, hi: 30000, curve: "log", unit: "Hz" },
    frequency: { lo: 30, hi: 22000, curve: "log", unit: "Hz" },
    resonance: { lo: 0, hi: 0.9, curve: 1, unit: "%" },
    peak:      { lo: -12, hi: 12, curve: 1, unit: "dB" },
    crush_decay:    { lo: 0.01, hi: 5, curve: "log", unit: "s", top: "Off" },
    stretch_factor: { lo: 1, hi: 20, curve: 2, unit: "x" },
    stretch_grain:  { lo: 0.005, hi: 0.3, curve: 2, unit: "s" },
    loop_offset:    { lo: 0, hi: 1, curve: 2, unit: "%" },
    loop_length:    { lo: 0.01, hi: 0.5, curve: 2, unit: "s" },
    pitch_amount:   { lo: -1, hi: 1, curve: 1, unit: "%" },
    pitch_decay:    { lo: 0.005, hi: 2, curve: 3, unit: "s" },
    punch_amount:   { lo: 0, hi: 1, curve: 1, unit: "%" },
    punch_release:  { lo: 0.06, hi: 1, curve: 3, unit: "s" },
    fm_amount:      { lo: 0, hi: 1, curve: 3, unit: "%" },
    fm_freq:        { lo: 10, hi: 4500, curve: "log", unit: "Hz" },
    ring_amount:    { lo: 0, hi: 1, curve: 1, unit: "%" },
    ring_freq:      { lo: 1, hi: 5000, curve: 5, unit: "Hz" },
    sub_amount:     { lo: 0, hi: 1, curve: 1, unit: "%" },
    sub_freq:       { lo: 30, hi: 120, curve: "log", unit: "Hz" },
    noise_amount:   { lo: 0, hi: 1, curve: 1, unit: "%" },
    noise_color:    { lo: 180, hi: 15000, curve: 2, unit: "Hz" }
};

function clampPos(pos) {
    return pos < 0 ? 0 : (pos > KNOB_UNITS ? KNOB_UNITS : pos);
}

/* The value at position pos. */
export function knobValue(spec, pos) {
    var p = clampPos(pos) / KNOB_UNITS;
    if (spec.curve === "log") return spec.lo * Math.pow(spec.hi / spec.lo, p);
    return spec.lo + (spec.hi - spec.lo) * Math.pow(p, spec.curve);
}

/* The position of value v (clamped to the range): knobValue's inverse. */
export function knobPos(spec, v) {
    var p;
    if (spec.curve === "log") {
        p = v > spec.lo ? Math.log(v / spec.lo) / Math.log(spec.hi / spec.lo) : 0;
    } else {
        var f = (v - spec.lo) / (spec.hi - spec.lo);
        p = f > 0 ? Math.pow(f, 1 / spec.curve) : 0;
    }
    return clampPos(p * KNOB_UNITS);
}

/* Three significant figures, as Move shows times and frequencies:
 * "1.03", "10.6", "110". x >= 0. */
function sig3(x) {
    return x.toFixed(x < 9.995 ? 2 : (x < 99.95 ? 1 : 0));
}

/* "0.10 ms", "10.6 ms", "110 ms", "1.03 s", "20.0 s". */
export function formatTime(s) {
    var ms = s * 1000;
    return ms < 999.5 ? sig3(ms) + " ms" : sig3(s) + " s";
}

/* "1.00 Hz", "30.0 Hz", "250 Hz", "1.20 kHz", "12.5 kHz". */
export function formatHz(hz) {
    return hz < 999.5 ? sig3(hz) + " Hz" : sig3(hz / 1000) + " kHz";
}

/* Move's percentages and dB: one decimal below 10 (by size), none from 10
 * up, no "+": "-6.7", "0.0", "-14", "100". */
export function formatSmall(x) {
    var s = Math.abs(x) < 9.95 ? x.toFixed(1) : String(Math.round(x));
    return /^-0(\.0)?$/.test(s) ? s.substring(1) : s;
}

/* The readout for position pos, e.g. "0.10 ms", "Inf", "22.0 kHz". */
export function formatKnob(spec, pos) {
    if (spec.top && pos >= KNOB_UNITS) return spec.top;
    var v = knobValue(spec, pos);
    switch (spec.unit) {
    case "s":  return formatTime(v);
    case "Hz": return formatHz(v);
    case "%":  return formatSmall(v * 100) + " %";
    case "x":  return v.toFixed(2);
    default:   return formatSmall(v) + " dB";
    }
}

var SPOKEN_UNITS = { "ms": "milliseconds", "s": "seconds", "Hz": "hertz", "kHz": "kilohertz",
                     "%": "percent", "dB": "decibels", "st": "semitones", "ct": "cents" };

/* A readout for the screen reader: "0.10 milliseconds", "infinite". */
export function spokenReadout(text) {
    if (text === "Inf") return "infinite";
    var i = text.lastIndexOf(" ");
    if (i < 0) return text;
    var unit = SPOKEN_UNITS[text.substring(i + 1)];
    return unit ? text.substring(0, i) + " " + unit : text;
}

/* Turn a knob by ticks clicks from pos (Shift: fine). Each click keeps
 * stepping until the readout changes, or the knob reaches an end. */
export function stepKnob(spec, pos, ticks, fine) {
    var step = (ticks > 0 ? 1 : -1) * (fine ? 1 : KNOB_CLICK);
    for (var n = Math.abs(ticks); n > 0; n--) {
        var shown = formatKnob(spec, pos);
        do {
            pos = clampPos(pos + step);
        } while (pos > 0 && pos < KNOB_UNITS && formatKnob(spec, pos) === shown);
    }
    return pos;
}
