// Smoke test for src/ui.js and src/drum_rack.mjs: runs the UI under node
// with a fake host and a fake DSP, drives init/tick/MIDI, and checks the
// exported drum rack preset. Catches JS errors before a device build.
// Needs ../schwung (shared modules, a Move set fixture) and
// ../schwung-waveform-editor (reference preset structure).
//
//   node tests/ui_smoke.mjs        (exit code 1 on any failure)
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shared = path.resolve(repo, '../schwung/src/shared');
const dir = path.join(repo, 'build');
fs.mkdirSync(dir, { recursive: true });
let src = fs.readFileSync(path.join(repo, 'src/ui.js'), 'utf8');
src = src.replaceAll('/data/UserData/schwung/shared/', pathToFileURL(shared).href + '/');
src = src.replaceAll("'./drum_rack.mjs'", "'" + pathToFileURL(path.join(repo, 'src/drum_rack.mjs')).href + "'");
fs.writeFileSync(path.join(dir, 'ui_under_test.mjs'), src);

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.log('FAIL: ' + msg); }
}

const log = [];
const files = {};
const g = globalThis;
let vlines = [];   // heights of vertical lines drawn this frame (the waveform)
for (const f of ['clear_screen', 'set_pixel', 'draw_rect', 'fill_rect', 'draw_line'])
  g[f] = (...a) => {
    if (a.some(v => typeof v === 'number' && !Number.isFinite(v))) throw new Error(f + ' got non-finite ' + JSON.stringify(a));
    if (f === 'draw_line' && a[0] === a[2]) vlines.push({ len: Math.abs(a[3] - a[1]), mid: (a[1] + a[3]) / 2 });
  };
let printed = [];
g.print = (x, y, t) => { if (typeof t !== 'string') throw new Error('print non-string'); printed.push(t); };
g.text_width = t => t.length * 5;
const buttonLeds = {};
const padLeds = {};
g.move_midi_internal_send = m => { if (m[0] === 0x0b) buttonLeds[m[2]] = m[3]; if (m[0] === 0x09) padLeds[m[2]] = m[3]; return true; };
const WHITE = 120, RED = 1, BLUE = 125;
const lit = cc => buttonLeds[cc] > 0;
const UNDO = 56, DELETE = 119, RECORD = 118, CAPTURE = 52, MUTE = 88;
g.host_send_screenreader = t => log.push('SAY: ' + t);
g.host_announce_screenreader = g.host_send_screenreader;
g.shadow_get_display_mode = () => 1;
g.host_exit_module = () => log.push('EXIT');
g.host_file_exists = p => p in files;
g.host_ensure_dir = () => true;
g.host_write_file = (p, c) => { files[p] = c; return true; };
g.host_tool_file_path = '/data/UserData/UserLibrary/Samples/test loop.wav';

// Fake DSP state
const dsp = { frames: 441000, rate: 44100, playing: 0, pos: 0, starts: [0], ends: [441000], sel: 0,
  settings: '0 -1 50000 0', chop: 0, undo: 0, del: 0, depth: 0, redo: 0, redoDepth: 0,
  exportReq: 0, exportDone: 0, exportWritten: 0, uiState: '', filePath: '',
  normGain: '0', channels: '2', convReq: 0, convDone: 0, convStatus: 0 };
const sets = [];
let lastWave = null;
let waveRequests = 0;   // [_, from, to, cols] of the last waveform request
g.host_module_get_param = k => {
  if (k === 'status') return `ready ${dsp.frames} ${dsp.rate} ${dsp.playing} ${dsp.pos}`;
  if (k === 'slices') return [dsp.chop, dsp.undo, dsp.del, dsp.depth, dsp.redo, dsp.redoDepth, dsp.playing ? 0 : -1, dsp.sel, dsp.starts.length,
    ...dsp.starts.flatMap((s, i) => [s, dsp.ends[i]])].join(' ');
  if (k === 'settings') return dsp.settings;
  if (k.startsWith('wave ')) { waveRequests++; lastWave = k.split(' ').map(Number); const c = lastWave[3]; return 'a0'.repeat(c); }
  if (k === 'error') return '';
  if (k === 'ui_state') return dsp.uiState;
  if (k === 'file_path') return dsp.filePath;
  if (k === 'normalize_gain') return dsp.normGain;
  if (k === 'channels') return dsp.channels;
  if (k === 'convert_result') return `${dsp.convReq} ${dsp.convDone} ${dsp.convStatus}`;
  if (k === 'export_result') return `${dsp.exportReq} ${dsp.exportDone} ${dsp.exportWritten}`;
  return null;
};
const fakeSet = (k, v) => {
  sets.push(k + '=' + v);
  if (k === 'export_slices') dsp.exportReq++;
  if (k === 'ui_state') dsp.uiState = v;
  if (k === 'convert_channels') dsp.convReq++;
  if (k === 'file_path') dsp.filePath = v;
  return true;
};
g.host_hide_module = () => log.push('HIDE');
g.host_module_set_param = fakeSet;
g.host_module_set_param_blocking = fakeSet;
let keyboardText = null;   // what the fake on-screen keyboard "types"; null = cancel
g.host_open_text_entry = o => {
  log.push('KEYBOARD: ' + o.initialText);
  if (keyboardText === null) o.onCancel(); else o.onConfirm(keyboardText);
};

await import(pathToFileURL(path.join(dir, 'ui_under_test.mjs')).href);
const tick = n => { for (let i = 0; i < n; i++) { printed = []; vlines = []; g.tick(); } };
const midi = (s, d1, d2) => g.onMidiMessageInternal([s, d1, d2]);
const READOUT = /^(Start|Length|Zoom|Gain|Attack|Hold|Decay|Transpose|Detune|Effect|Rate|Frequency|Resonance|Peak Gain|Type|Mode) |^-$/;
// Knobs by number (1-8): touch notes 0-7, CCs 71-78
const shift = on => midi(0xB0, 49, on ? 127 : 0);
const touch = (k, on) => midi(0x90, k - 1, on ? 127 : 0);
const turn = (k, v) => midi(0xB0, 70 + k, v);
const shiftTap = k => { shift(true); touch(k, true); touch(k, false); shift(false); };
const DOWN = 54;
const UP = 55;
const filterPage = () => midi(0xB0, DOWN, 127);
const mainPage = () => midi(0xB0, UP, 127);
let mark;

g.init(); tick(5);
check(!lit(UNDO) && !lit(DELETE) && lit(RECORD), 'one slice: only Record lit');
// Three slices
dsp.starts = [0, 100000, 200000]; dsp.ends = [100000, 200000, 441000]; dsp.chop = 2; dsp.depth = 2; dsp.sel = 1;
tick(2);
check(lit(UNDO) && lit(DELETE) && lit(RECORD), 'three slices: Undo, Delete, Record lit');
// The selected pad stays white while silent; the others are red, the target blue
check(!dsp.playing && padLeds[69] === WHITE && padLeds[68] === RED && padLeds[70] === RED && padLeds[71] === BLUE,
      'selected Pad 2 lit white while silent: ' + JSON.stringify([padLeds[68], padLeds[69], padLeds[70], padLeds[71]]));
dsp.sel = 2; tick(1);
check(padLeds[70] === WHITE && padLeds[69] === RED, 'white follows the selection');
dsp.sel = 1; tick(1);

// Shift+tap Knob 5 switches it to Length (the end marker), as on Move
mark = sets.length;
shiftTap(5); tick(1);
check(printed.includes('Length 23%') && log.at(-1) === 'SAY: Pad 2 length 23 percent',
      'Shift+tap Knob 5: Length, as a percentage of the sample: ' + JSON.stringify(printed) + ' ' + log.at(-1));
check(sets.slice(mark).every(s => s.startsWith('ui_state=')), 'the tap itself changes nothing');
// Zoom (Shift + Knob 2) centers on the selected slice's start, even with the end marker active
shift(true); turn(2, 5); shift(false); tick(1);
{
  const [, from, to] = lastWave, mid = (from + to) / 2;
  check(from <= 100000 && to > 100000 && Math.abs(mid - 100000) <= 2,
        'zoom centers on the start marker, not the end: ' + from + '-' + to);
}
// Turning Length moves the end, and the view follows it
mark = sets.length;
touch(5, true); turn(5, 120); touch(5, false); tick(1);
check(lastWave[1] > 100000, 'moving the end scrolls the view to it: ' + lastWave[1] + '-' + lastWave[2]);
check(sets.slice(mark).some(s => /^nudge=1 1 -\d+$/.test(s)), 'Length nudges the end: ' + JSON.stringify(sets.slice(mark)));
// Touching zoom (Shift + Knob 2) recenters on the start
shift(true); touch(2, true); tick(1); touch(2, false); shift(false);
{
  const [, from, to] = lastWave, mid = (from + to) / 2;
  check(Math.abs(mid - 100000) <= 2, 'touching zoom recenters on the start: ' + from + '-' + to);
}
// A Shift+turn of Knob 5 is fine steps, not a tap: it stays Length
shift(true); touch(5, true); turn(5, 1); touch(5, false); shift(false); tick(1);
touch(5, true); tick(1); touch(5, false);
check(printed.some(t => t.startsWith('Length ')), 'Shift + turning Knob 5 does not switch it: ' + JSON.stringify(printed));
// Selecting a short slice with the end marker active still shows its start
dsp.starts = [0, 100000, 130000]; dsp.ends = [100000, 130000, 441000]; dsp.sel = 0; tick(1);
shift(true); turn(2, 7); shift(false); tick(1);                            // zoom x8: view ~55k frames
touch(2, true); touch(2, false); touch(5, true); touch(5, false); tick(1);   // end active
check(lastWave[1] > 50000, 'end marker active and in view: ' + lastWave[1] + '-' + lastWave[2]);
tick(70);
check(printed.some(t => t.startsWith('S 0.000s ')), 'bottom line shows the start even with the end active: ' + JSON.stringify(printed));
dsp.sel = 1; tick(1);                                               // play pad 2
check(lastWave[1] <= 100000 && lastWave[2] >= 130000, 'selected slice start and end both shown: ' + lastWave[1] + '-' + lastWave[2]);
dsp.sel = 2; tick(1);                                               // long slice: start wins
check(lastWave[1] <= 130000 && lastWave[2] > 130000, 'long slice shows its start: ' + lastWave[1] + '-' + lastWave[2]);
shift(true); turn(2, 121); shift(false); tick(1);
dsp.starts = [0, 100000, 200000]; dsp.ends = [100000, 200000, 441000]; dsp.sel = 1; tick(1);
shift(true); turn(2, 123); shift(false); touch(2, true); touch(2, false); tick(1);   // zoom back out, start active
shiftTap(5); tick(1);
check(log.at(-1).startsWith('SAY: Decay '), 'Shift+tap again: back to Decay: ' + log.at(-1));
tick(70);

// Knob touch shows a readout, turning updates it, on both pages
for (const pg of ['Main', 'Filter & Setup']) {
  for (let k = 1; k <= 8; k++) {
    touch(k, true); tick(1);
    const shown = printed.find(t => READOUT.test(t));
    turn(k, 3); tick(1);
    const after = printed.find(t => READOUT.test(t));
    touch(k, false); tick(70);
    check(shown, `${pg} knob ${k} touch shows a readout`);
    console.log(`${pg} knob ${k}: touch="${shown}" turned="${after}"`);
  }
  if (pg === 'Main') { filterPage(); tick(70); }
}
// Put back what the loop changed that the tests below start from: Mode
// (Gate), Type (Peak), Resonance; Effect (8-Bit). Gain stays at +1.5 dB.
turn(4, 127); turn(3, 126); turn(2, 125); tick(1);
mainPage(); tick(1);
turn(6, 127); tick(70);

// ---- Pages: Down is Filter & Setup, Up is Main ----
check(lit(DOWN) && !lit(UP), 'Main page: Down lit (the other page), Up dark');
filterPage(); tick(1);
check(printed.includes('Filter & Setup') && log.at(-1) === 'SAY: Filter and Setup page' && lit(UP) && !lit(DOWN),
      'Down: Filter & Setup page, Up lit, Down dark: ' + JSON.stringify(printed));
filterPage(); tick(1);
check(lit(UP) && log.at(-1) === 'SAY: Filter and Setup page', 'Down again stays there');

// Gain is Filter & Setup Knob 8: 0.5 dB steps (Shift 0.1) from -24 dB up, 2 dB below, -70 to +24 dB
const gainSets = () => sets.filter(x => x.startsWith('gain_db10='));
touch(8, true); tick(1);
turn(8, 127); tick(1);                       // knob loop left it at +1.5 dB
check(printed.includes('Gain +1.0dB') && gainSets().at(-1) === 'gain_db10=10', 'one step down is 0.5 dB: ' + JSON.stringify(printed));
shift(true); turn(8, 1); shift(false); tick(1);
check(printed.includes('Gain +1.1dB'), 'Shift: 0.1 dB steps: ' + JSON.stringify(printed));
turn(8, 63); tick(1);
check(printed.includes('Gain +24.0dB') && gainSets().at(-1) === 'gain_db10=240', 'tops out at +24 dB');
turn(8, 65); turn(8, 65); tick(1);   // 126 steps down
check(printed.includes('Gain -70.0dB') && gainSets().at(-1) === 'gain_db10=-700', 'bottoms out at -70 dB: ' + JSON.stringify(printed));
turn(8, 23); tick(1);                       // 23 x 2 dB = -24 dB
check(printed.includes('Gain -24.0dB'), '2 dB steps below -24 dB: ' + JSON.stringify(printed));
turn(8, 2); tick(1);
check(printed.includes('Gain -23.0dB'), '0.5 dB steps from -24 dB up: ' + JSON.stringify(printed));
turn(8, 46); tick(1);
check(printed.includes('Gain 0.0dB'), 'back to 0 dB: ' + JSON.stringify(printed));
touch(8, false); tick(70);
check(log.includes('SAY: Gain 0.0 decibels'), 'gain spoken: ' + log.slice(-3));

// The waveform is drawn at the gained level
// Waveform columns are centred on the wave's midline (markers run top to bottom)
const WAVE_MID_Y = 28, WAVE_HALF_H = 18;   // ui.js WAVE_MID / WAVE_HALF; fake peaks are 0xa0
const waveCols = () => vlines.filter(l => l.mid === WAVE_MID_Y && l.len < 40).map(l => l.len);
const waveH = () => { tick(1); return Math.max(0, ...waveCols()); };
const waveWant = db => 2 * Math.min(WAVE_HALF_H, Math.round(0xa0 * Math.pow(10, db / 20) * WAVE_HALF_H / 255));
check(waveH() === waveWant(0), `waveform at 0 dB: ${waveH()} vs ${waveWant(0)}`);
turn(8, 6); tick(70);                       // +3 dB
check(waveH() === waveWant(3) && waveWant(3) > waveWant(0), `waveform taller at +3 dB: ${waveH()} vs ${waveWant(3)}`);
turn(8, 6); tick(70);                       // +6 dB: past the edge
check(waveH() === 2 * WAVE_HALF_H, 'a boost flattens at the edges: ' + waveH());
turn(8, 116); tick(70);                     // back to 0 dB
mainPage(); tick(1);
check(printed.includes('Main') && log.at(-1) === 'SAY: Main page' && lit(DOWN) && !lit(UP), 'Up: Main page, Down lit, Up dark');
tick(70);

// Shift + Knob 1 is detune in cents (-50 to +50), leaving transpose alone
mark = sets.length;
shift(true); touch(1, true); tick(1);
check(printed.includes('Detune 0ct'), 'Shift + touching Knob 1 shows detune: ' + JSON.stringify(printed));
turn(1, 5); tick(1);
check(printed.includes('Detune +5ct'), 'Shift + Knob 1 turns detune: ' + JSON.stringify(printed));
check(sets.slice(mark).includes('detune=5') && !sets.slice(mark).some(s => s.startsWith('transpose=')),
      'detune sent, transpose untouched: ' + JSON.stringify(sets.slice(mark)));
turn(1, 63); tick(1);
check(printed.includes('Detune +50ct') && sets.at(-1) === 'detune=50', 'detune clamps at +50');
turn(1, 65); turn(1, 65); tick(1);
check(printed.includes('Detune -50ct') && sets.at(-1) === 'detune=-50', 'detune clamps at -50');
turn(1, 20); tick(1);
check(sets.at(-1) === 'detune=-30', 'detune back to -30: ' + sets.at(-1));
touch(1, false); shift(false); tick(70);
check(log.some(l => l === 'SAY: Detune -30 cents'), 'detune announced');
touch(1, true); tick(1);
check(printed.some(t => t.startsWith('Transpose')), 'without Shift, Knob 1 is transpose again');
touch(1, false); tick(70);

// Knob 6 is the effect: Off / 8-Bit. Knob 7 is the 8-Bit rate, kept while
// the effect is off; the knob loop left it at 15.1 kHz.
const crushSets = () => sets.filter(x => x.startsWith('crush_hz='));
mark = sets.length;
touch(6, true); tick(1);
check(printed.includes('Effect Off') && log.at(-1) === 'SAY: Effect off', 'Knob 6 shows the effect: ' + JSON.stringify(printed));
turn(6, 127); tick(1);
check(printed.includes('Effect Off') && !sets.slice(mark).some(s => s.startsWith('crush_hz=')), 'left of Off stays Off, sends nothing');
touch(6, false); touch(7, true); tick(1);
check(printed.includes('-') && log.at(-1) === 'SAY: 8-Bit rate, the effect is off', 'Knob 7 shows "-" while the effect is off');
turn(7, 5); tick(1);
check(!sets.slice(mark).some(s => s.startsWith('crush_hz=')), 'Knob 7 does nothing while the effect is off');
touch(7, false); touch(6, true); turn(6, 1); tick(1);
check(printed.includes('Effect 8-Bit') && crushSets().at(-1) === 'crush_hz=15100', 'on again at the rate it had: ' + crushSets().at(-1));
const onSets = crushSets().length;
turn(6, 1); tick(1);
check(crushSets().length === onSets && printed.includes('Effect 8-Bit'), 'right of 8-Bit stays 8-Bit, sends nothing');
touch(6, false); touch(7, true); tick(1);
check(printed.includes('Rate 15.1 kHz'), 'Knob 7 shows the rate: ' + JSON.stringify(printed));
turn(7, 63); tick(1);
check(printed.includes('Rate 30.0 kHz') && crushSets().at(-1) === 'crush_hz=30000', 'tops out at 30.0 kHz: ' + JSON.stringify(printed));
turn(7, 127); tick(1);
check(printed.includes('Rate 29.3 kHz'), '1/24 octave steps, 100 Hz precision above 10 kHz: ' + JSON.stringify(printed));
turn(7, 65); turn(7, 65); tick(1);   // 126 steps down
check(printed.includes('Rate 1.00 kHz') && crushSets().at(-1) === 'crush_hz=1000', 'bottoms out at 1.00 kHz: ' + JSON.stringify(printed));
turn(7, 1); tick(1);
check(printed.includes('Rate 1.03 kHz'), '10 Hz precision below 10 kHz: ' + JSON.stringify(printed));
shift(true); turn(7, 1); shift(false); tick(1);
check(printed.includes('Rate 1.04 kHz') && crushSets().at(-1) === 'crush_hz=1040', 'Shift: 1/96 octave steps: ' + JSON.stringify(printed));
turn(7, 63); turn(7, 8); tick(1);    // 71 steps: the first reaches 1.06 kHz, then up to 8 kHz
check(printed.includes('Rate 8.00 kHz') && crushSets().at(-1) === 'crush_hz=8000', 'rate at 8.00 kHz: ' + JSON.stringify(printed));
check(!sets.slice(mark).some(s => !/^(crush_hz|ui_state)=/.test(s)), 'Knobs 6 and 7 send only crush: ' + JSON.stringify(sets.slice(mark)));
touch(7, false); tick(70);
check(log.includes('SAY: 8-Bit rate 8 kilohertz'), 'rate announced: ' + log.slice(-3));
// Knob 8 on the Main page is not used (8-Bit Decay stays at Move's default)
mark = sets.length;
touch(8, true); turn(8, 5); tick(1);
check(printed.includes('-') && log.at(-1) === 'SAY: Not used' && sets.slice(mark).every(s => s.startsWith('ui_state=')),
      'Main Knob 8 shows "-" and does nothing');
touch(8, false); tick(70);

// Top bar is just the pad; zoom, transpose and Start/End stay off it
tick(1);
check(printed[0] === 'Pad 2/3', `top bar shows only the pad (got "${printed[0]}")`);
check(!printed.some(t => /x\d|st\b|START|END/.test(t)), 'no zoom/transpose/START/END when idle: ' + JSON.stringify(printed));

// The jog only ever moves the start, even after touching Length
shiftTap(5); touch(5, true); tick(1); touch(5, false);
mark = sets.length;
midi(0xB0, 3, 127); midi(0xB0, 14, 1); tick(1);
check(sets.slice(mark).some(s => /^nudge=\d+ 0 \d+$/.test(s)) && !sets.slice(mark).some(s => /^nudge=\d+ 1 /.test(s)),
      'jog nudges the start: ' + JSON.stringify(sets.slice(mark)));
shiftTap(5); tick(70);

// Other controls run without throwing
midi(0xB0, 14, 1); midi(0xB0, 3, 127); midi(0xB0, 62, 127); midi(0xB0, 56, 127); tick(30);

// ---- Export ----
const settingSets = Object.fromEntries(sets.filter(s => /^(attack_us|hold_us|decay_us|transpose|detune)=/.test(s)).map(s => s.split('=')));
const presetDir = '/data/UserData/UserLibrary/Track Presets/';
const exits = () => log.filter(l => l === 'EXIT').length;
// Export menu (Record): row 0 name, then Drum Preset, Slices, Cancel
const menu = () => printed.includes('Export');
const jog = n => { for (let i = 0; i < Math.abs(n); i++) midi(0xB0, 14, n > 0 ? 1 : 127); };
const click = () => midi(0xB0, 3, 127);
function exportPreset() { midi(0xB0, 118, 127); jog(1); click(); tick(2); }
midi(0xB0, 52, 127); tick(1);
check(!menu() && Object.keys(files).length === 0, 'Capture no longer exports');
midi(0xB0, 118, 127); tick(1);
check(menu() && printed.includes('test loop Chop') && printed.includes('Slices') &&
      printed.includes('Drum Preset') && printed.includes('Cancel'), 'Record opens the export menu: ' + JSON.stringify(printed));
check(log.some(l => l === 'SAY: Export, test loop Chop'), 'menu announced with the name');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD), 'menu: buttons dark');
mark = sets.length;
midi(0xB0, 71, 5); midi(0x90, 4, 127); midi(0xB0, 119, 127); midi(0xB0, 56, 127); tick(1);
check(menu() && sets.length === mark, 'knobs, Delete and Undo ignored in the menu');
midi(0xB0, 51, 127); tick(1);
check(!menu() && exits() === 0, 'Back closes the menu without exiting');
midi(0xB0, 118, 127); tick(1); midi(0xB0, 118, 127); tick(1);
check(!menu(), 'Record closes the menu');
midi(0xB0, 118, 127); jog(10); click(); tick(1);
check(!menu() && Object.keys(files).length === 0 && log.at(-1) === 'SAY: Cancelled', 'Cancel exports nothing');
// Rename: the keyboard opens with the name; slashes and a leading dot are cleaned
midi(0xB0, 118, 127); jog(-5); keyboardText = '.My/Kit '; click(); tick(1);
check(log.includes('KEYBOARD: test loop Chop'), 'keyboard opens with the current name');
check(menu() && printed.includes('My-Kit'), 'renamed to My-Kit: ' + JSON.stringify(printed));
keyboardText = null; click(); tick(1);
check(menu() && printed.includes('My-Kit'), 'cancelling the keyboard keeps the name');
jog(1); click(); tick(2);
check(presetDir + 'My-Kit.ablpreset' in files, 'Drum Preset uses the new name');
check(!menu(), 'menu closes after exporting');
exportPreset();                        // default name
exportPreset();                        // again: must not overwrite
const p1 = presetDir + 'test loop Chop.ablpreset';
const p2 = presetDir + 'test loop Chop 2.ablpreset';
check(p1 in files, 'first export written to ' + p1);
check(p2 in files, 'second export gets a new name ' + p2);
// A crush change after exporting counts as unexported work
midi(0xB0, 51, 127); tick(1);
check(!printed.includes('Not exported'), 'just exported: no warning');
midi(0xB0, 51, 127); tick(1);
turn(7, 127); turn(7, 1); tick(1);              // 8-Bit rate down and back up
midi(0xB0, 51, 127); tick(1);
check(printed.includes('Not exported'), 'a crush change counts as unexported');
midi(0xB0, 51, 127); tick(1);

if (p1 in files) {
  const preset = JSON.parse(files[p1]);
  const rack = preset.chains[0].devices[0];
  check(rack.kind === 'drumRack', 'drum rack device');
  check(rack.chains.length === 16, '16 pad chains');
  rack.chains.forEach((c, i) => {
    const cell = c.devices[0];
    const p = cell.parameters;
    check(c.drumZoneSettings.receivingNote === 36 + i, `pad ${i + 1} note ${36 + i}`);
    check(c.drumZoneSettings.chokeGroup === 1, `pad ${i + 1} choke group 1`);
    check(c.mixer.speakerOn === (i < 3), `pad ${i + 1} speaker ${i < 3 ? 'on' : 'off'}`);
    check(cell.deviceData.sampleUri === 'ableton:/user-library/Samples/test%20loop.wav', 'sample URI encoded');
    if (i < 3) {
      const s = dsp.starts[i] / dsp.frames, l = (dsp.ends[i] - dsp.starts[i]) / dsp.frames;
      check(Math.abs(p.Voice_PlaybackStart - s) < 1e-12, `pad ${i + 1} start ${s}`);
      check(Math.abs(p.Voice_PlaybackLength - l) < 1e-12, `pad ${i + 1} length ${l}`);
    }
    check(p.Voice_Envelope_Mode === 'A-H-D', 'A-H-D mode');
    check(Math.abs(p.Voice_Envelope_Attack - Math.max(0.0001, settingSets.attack_us / 1e6)) < 1e-9, 'attack seconds');
    check(p.Voice_Envelope_Hold === (+settingSets.hold_us < 0 ? 60 : +settingSets.hold_us / 1e6), 'hold seconds');
    check(Math.abs(p.Voice_Envelope_Decay - settingSets.decay_us / 1e6) < 1e-9, 'decay seconds');
    check(p.Voice_Transpose === +settingSets.transpose, 'transpose');
    // Move's Song.abl stores detune in semitones: -0.25 st was saved as -0.2522932291030884
    check(Math.abs(p.Voice_Detune - -0.3) < 1e-12 && +settingSets.detune === -30, 'detune -30 cents exported as -0.3 semitones: ' + p.Voice_Detune);
    check(p.Effect_Type === '8-bit' && p.Effect_EightBitResamplingRate === 8000 && p.Effect_EightBitFilterDecay === 5 && p.Effect_On === true,
          'crush exported as the 8-Bit effect at 8000 Hz: ' + [p.Effect_Type, p.Effect_EightBitResamplingRate]);
  });
  const c0 = rack.chains[0].devices[0].parameters;
  console.log(`export: attack=${c0.Voice_Envelope_Attack}s hold=${c0.Voice_Envelope_Hold}s decay=${c0.Voice_Envelope_Decay}s transpose=${c0.Voice_Transpose} detune=${c0.Voice_Detune}`);

  // Same drumCell parameter names as a real Move set
  const fixture = JSON.parse(fs.readFileSync(path.resolve(repo, '../schwung/tests/fixtures/song_abl_sample.json'), 'utf8'));
  let moveCell = null;
  (function walk(o) {
    if (moveCell || !o || typeof o !== 'object') return;
    if (o.kind === 'drumCell') { moveCell = o; return; }
    Object.values(o).forEach(walk);
  })(fixture);
  const ours = Object.keys(c0).sort().join(','), theirs = Object.keys(moveCell.parameters).sort().join(',');
  check(ours === theirs, 'drumCell parameter names match a Move set');

  // Same structure (keys and types) as the waveform editor's export
  const weSrc = fs.readFileSync(path.resolve(repo, '../schwung-waveform-editor/src/ui.js'), 'utf8');
  const body = weSrc.substring(weSrc.indexOf('function buildDrumCellParams'), weSrc.indexOf('/**\n * Undo last destructive'));
  const weFiles = {};
  const run = new Function('fileName', 'totalFrames', 'openedFilePath', 'sliceCount', 'sliceBoundaries',
    'host_write_file', 'host_ensure_dir', 'showStatus', 'announce', 'leafFolder',
    body + '\nsaveDrumRackPreset(false);');
  run('test loop.wav', dsp.frames, g.host_tool_file_path, 3, [0, 100000, 200000, 441000],
    (p, c) => { weFiles[p] = c; return true; }, () => true, () => {}, () => {}, () => '');
  const weg = JSON.parse(Object.values(weFiles)[0]);
  const shape = o => Array.isArray(o) ? [shape(o[0])] : (o && typeof o === 'object')
    ? Object.fromEntries(Object.keys(o).sort().map(k => [k, shape(o[k])])) : typeof o;
  check(JSON.stringify(shape(preset)) === JSON.stringify(shape(weg)), 'preset structure matches the waveform editor export');
}

// Files outside the User Library are refused
const { sampleUriFor } = await import(pathToFileURL(path.join(repo, 'src/drum_rack.mjs')).href);
check(sampleUriFor('/data/UserData/other/x.wav') === null, 'sample outside User Library refused');
check(sampleUriFor('/data/UserData/UserLibrary/Samples/a#b 100%.wav') === 'ableton:/user-library/Samples/a%23b%20100%25.wav', 'special characters encoded');

// ---- Delete ----
mark = sets.length;
midi(0xB0, 119, 127); tick(1);
check(sets.slice(mark).includes('delete=' + dsp.sel), 'Delete sends the selected slice');
dsp.del = 1; dsp.starts = [0, 200000]; dsp.ends = [200000, 441000]; dsp.sel = 0; tick(2);
check(log.some(l => l.startsWith('SAY: Deleted, Pad 1 selected, 2 slices')), 'delete announced');

// ---- Redo ----
dsp.undo = 1; dsp.depth = 1; dsp.redoDepth = 1; tick(1);
check(lit(UNDO), 'Undo lit with undo history');
midi(0xB0, 49, 127); tick(1);
check(lit(UNDO), 'Shift: Undo lit when there is something to redo');
mark = sets.length;
midi(0xB0, 56, 127); tick(1);
check(sets.slice(mark).includes('redo=1') && !sets.slice(mark).includes('undo=1'), 'Shift+Undo sends redo');
dsp.redo = 1; dsp.redoDepth = 0; dsp.depth = 2; tick(1);
check(log.some(l => l.startsWith('SAY: Redo, 2 slices')), 'redo announced');
check(!lit(UNDO), 'Shift: Undo dark with nothing to redo');
midi(0xB0, 56, 127); tick(1);
check(log.some(l => l === 'SAY: Nothing to redo'), 'Shift+Undo with nothing to redo says so');
midi(0xB0, 49, 0); tick(1);
check(lit(UNDO), 'Shift released: Undo lit again for undo');
mark = sets.length;
midi(0xB0, 56, 127); tick(1);
check(sets.slice(mark).includes('undo=1'), 'Undo without Shift still undoes');

// ---- Mute does nothing: Envelope Mode (Filter & Setup Knob 4) sets the gate ----
check(!lit(MUTE), 'Mute dark');
mark = sets.length;
midi(0xB0, 88, 127); tick(70);
check(sets.slice(mark).length === 0 && !lit(MUTE), 'Mute does nothing');
filterPage(); turn(4, 1); tick(1); mainPage(); tick(70);
check(sets.includes('gate=1'), 'Mode Gate sends gate=1');
midi(0xB0, 118, 127); tick(1);
check(!lit(UP) && !lit(DOWN), 'page buttons dark in the export menu');
jog(1); click(); tick(2);
const gatedPreset = JSON.parse(files[presetDir + 'test loop Chop 3.ablpreset'] || '{}');
check(gatedPreset.chains && gatedPreset.chains[0].devices[0].chains[0].devices[0].parameters.Voice_Envelope_Mode === 'A-S-R',
      'gated exports as A-S-R');
mark = sets.length;
filterPage(); turn(4, 127); tick(1); mainPage(); tick(70);
check(sets.slice(mark).includes('gate=0'), 'Mode Trigger: one-shot again');

// ---- Export slices ----
const sampleDir = '/data/UserData/UserLibrary/Samples/';
files[sampleDir + 'test loop Chop'] = 'dir';     // folder taken: pick the next name
dsp.chop = 4; tick(1);                            // unexported work
mark = sets.length;
midi(0xB0, 118, 127); jog(2); click(); tick(1);
check(sets.slice(mark).includes('export_slices=' + sampleDir + 'test loop Chop 2/test loop Chop 2'),
      'Slices asks the DSP for a new folder: ' + JSON.stringify(sets.slice(mark)));
check(printed.includes('Exporting...') && !lit(RECORD), 'exporting shown, Record dark');
midi(0xB0, 118, 127); tick(1);
check(!menu() && log.at(-1) === 'SAY: Still exporting', 'Record waits for the export');
const n = dsp.starts.length;
dsp.exportDone = dsp.exportReq; dsp.exportWritten = n - 1; tick(1);
check(log.some(l => l.startsWith(`SAY: Export incomplete, saved ${n - 1} of ${n}`)), 'partial export reported');
midi(0xB0, 51, 127); tick(1);
check(printed.includes('Not exported'), 'a partial export still counts as unexported');
midi(0xB0, 51, 127); tick(1);
midi(0xB0, 118, 127); jog(2); click(); tick(1);
dsp.exportDone = dsp.exportReq; dsp.exportWritten = n; tick(1);
check(log.some(l => l === `SAY: Exported ${n} slices to test loop Chop 2`), 'slices export announced');
check(lit(RECORD), 'Record lit again');
dsp.chop = 5; tick(1);                            // more unexported work for the prompt tests

// ---- Back menu: Keep for later / Discard and exit (or Exit) / Cancel ----
const prompt = () => printed.includes('Not exported');
midi(0xB0, 51, 127); tick(1);
check(prompt() && exits() === 0, 'Back with unexported changes asks first');
check(['Keep for later', 'Discard and exit', 'Cancel'].every(t => printed.includes(t)), 'Back menu items: ' + JSON.stringify(printed));
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD), 'prompt: Undo, Delete, Record dark');
check(!printed.some(t => /Export/.test(t)), 'prompt offers no export');
check(log.at(-1) === 'SAY: Not exported. Keep for later', 'prompt starts on Keep for later');
mark = sets.length;
const fileCount = Object.keys(files).length;
midi(0xB0, 71, 5); midi(0x90, 4, 127); midi(0xB0, 118, 127); tick(1);
check(prompt() && !sets.slice(mark).some(s => !s.startsWith('ui_state=')), 'knobs ignored while asking');
check(Object.keys(files).length === fileCount, 'Record ignored while asking');
midi(0xB0, 51, 127); tick(1);
check(!prompt() && exits() === 0, 'Back in the prompt cancels');
check(lit(DELETE) && lit(RECORD), 'Delete and Record lit again after cancelling');
midi(0xB0, 51, 127); jog(2); click(); tick(1);
check(!prompt() && exits() === 0, 'choosing Cancel stays');
midi(0xB0, 51, 127); jog(3); click(); tick(1);
check(!prompt() && exits() === 0, 'jog past the end stays on Cancel');
midi(0xB0, 51, 127); jog(1); click(); tick(1);
check(exits() === 1 && !log.includes('HIDE'), 'Discard and exit exits');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD), 'exit turns the buttons off');
dsp.chop = 3; tick(1);                   // more unexported work
exportPreset();                          // exports it
midi(0xB0, 51, 127); tick(1);
check(!prompt() && printed.includes('Leave LiveChopper') && printed.includes('Exit') && !printed.includes('Discard and exit'),
      'everything exported: plain Exit, no warning: ' + JSON.stringify(printed));
jog(1); click(); tick(1);
check(exits() === 2, 'Exit exits');
dsp.chop = 6; tick(1);
midi(0xB0, 118, 127); jog(2); click(); tick(1);
dsp.exportDone = dsp.exportReq; dsp.exportWritten = dsp.starts.length; tick(1);
midi(0xB0, 51, 127); tick(1);
check(!prompt() && printed.includes('Exit'), 'a full slices export counts as exported');
midi(0xB0, 51, 127); tick(1);

// ---- Keep for later, then resume ----
shift(true); turn(2, 5); shift(false); tick(1);   // zoom in: remembered
shiftTap(5); filterPage(); tick(1);                   // Length, then the Filter & Setup page: remembered
dsp.chop = 7; tick(1);                            // unexported work
mark = sets.length;
midi(0xB0, 51, 127); click(); tick(1);       // the default: Keep for later
const keptState = dsp.uiState;
check(/^3 1 [\d.]+ 1 1$/.test(keptState) && !/^3 1 0 /.test(keptState), 'ui_state saved: zoom, page, Length: ' + keptState);
check(log.includes('HIDE') && exits() === 2, 'Keep for later hides instead of exiting');
check(sets.slice(mark).includes('stop=1'), 'Keep for later stops the voice');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD) && !lit(UP) && !lit(DOWN), 'hiding turns the buttons off');
check(log.some(l => l === 'SAY: Kept for later, resume from Tools'), 'hiding announced');

async function freshUi(tag) {
  await import(pathToFileURL(path.join(dir, 'ui_under_test.mjs')).href + '?' + tag);
}
await freshUi('resume');
g.host_tool_reconnect = true;
mark = sets.length;
const logMark = log.length;
g.init(); tick(2);
check(!sets.slice(mark).some(s => s.startsWith('file_path=')), 'resume does not reload the file');
check(log.slice(logMark).includes(`SAY: Resumed test loop.wav, ${dsp.starts.length} slices`), 'resume announced: ' + JSON.stringify(log.slice(logMark)));
check(!log.slice(logMark).some(l => /SAY: (Chop|Undo|Redo|Deleted)/.test(l)), 'resume does not replay old edits');
check(dsp.uiState === keptState, 'zoom, page, Length and unexported restored on resume: ' + dsp.uiState + ' vs ' + keptState);
check(lit(RECORD) && lit(UP) && !lit(DOWN), 'buttons lit again after resuming, Up back to Main from the Filter & Setup page');
touch(1, true); tick(1); touch(1, false);
check(printed.some(t => t.startsWith('Frequency ')), 'resumed on the Filter & Setup page: ' + JSON.stringify(printed));
mainPage(); touch(5, true); tick(1); touch(5, false);
check(printed.some(t => t.startsWith('Length ')), 'resumed with Knob 5 on Length: ' + JSON.stringify(printed));
shiftTap(5); tick(70);
midi(0xB0, 51, 127); tick(1);
check(prompt(), 'unexported work is still unexported after resuming');
midi(0xB0, 51, 127); tick(1);

// Reconnect after another tool replaced the DSP: load the file again
await freshUi('replaced');
dsp.filePath = '';
mark = sets.length;
g.init(); tick(1);
check(sets.slice(mark).includes('file_path=' + g.host_tool_file_path), 'replaced DSP: file loaded again');
delete g.host_tool_reconnect;

// ---- Tools menu (Shift + jog click): Normalize audio / Channels / Back ----
tick(70);
const tools = () => { midi(0xB0, 49, 127); click(); midi(0xB0, 49, 0); tick(1); };
tools();
check(printed.includes('Tools') && printed.includes('Normalize audio') && printed.includes('Channels') && printed.includes('Back'), 'Shift + jog click opens Tools: ' + JSON.stringify(printed));
check(log.at(-1) === 'SAY: Tools, Normalize audio', 'Tools announced');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD), 'Tools: buttons dark');
mark = sets.length;
midi(0xB0, 71, 5); midi(0x90, 4, 127); midi(0xB0, 118, 127); tick(1);
check(printed.includes('Tools') && !sets.slice(mark).some(s => !s.startsWith('ui_state=')), 'knobs and Record ignored in Tools');
jog(2); click(); tick(1);
check(!printed.includes('Tools') && log.at(-1) === 'SAY: Closed', 'Back item closes Tools');
tools(); midi(0xB0, 51, 127); tick(1);
check(!printed.includes('Tools') && exits() === 2 && log.at(-1) === 'SAY: Closed', 'Back button closes Tools without the exit menu');
click(); tick(1);
check(!printed.includes('Tools'), 'jog click without Shift does not open Tools');

// Normalize sets Gain from the DSP's peak: no prompt, no file written
midi(0xB0, 51, 127); tick(1);
check(!prompt(), 'nothing unexported before normalizing');
midi(0xB0, 51, 127); tick(1);
const fileCount2 = Object.keys(files).length;
dsp.normGain = '127';
tools(); click(); tick(1);
check(gainSets().at(-1) === 'gain_db10=127', 'Normalize sets the gain: ' + gainSets().at(-1));
check(printed.includes('Gain +12.7dB'), 'new gain shown: ' + JSON.stringify(printed));
check(log.at(-1) === 'SAY: Normalized, gain plus 12.7 decibels', 'normalize announced: ' + log.at(-1));
check(Object.keys(files).length === fileCount2, 'no file written');
midi(0xB0, 51, 127); tick(1);
check(prompt(), 'normalizing counts as unexported');
midi(0xB0, 51, 127); tick(1);
filterPage(); touch(8, true); tick(1);
check(printed.includes('Gain +12.7dB'), 'the Gain knob shows the normalized gain');
turn(8, 1); tick(1);
check(printed.includes('Gain +13.2dB'), 'and turns on from it');
turn(8, 127); touch(8, false); mainPage(); tick(70);
exportPreset();
const newestPreset = () => JSON.parse(files[Object.keys(files).filter(f => f.startsWith(presetDir)).at(-1)] || '{}');
const gp = newestPreset();
const vg = gp.chains && gp.chains[0].devices[0].chains[0].devices[0].parameters.Voice_Gain;
check(Math.abs(vg - Math.pow(10, 12.7 / 20)) < 1e-9, 'Drum Preset carries the gain as Voice_Gain: ' + vg);
// Move's own Song.abl (float32): +24 dB = 15.848933219909668, -70 dB = 0.0003162277571391314
const { buildDrumRackPreset } = await import(pathToFileURL(path.join(repo, 'src/drum_rack.mjs')).href);
const presetGain = db10 => buildDrumRackPreset({ name: 'g', sampleUri: 'u', frames: 10, starts: [0], ends: [10],
  env: { attackUs: 0, holdUs: -1, decayUs: 0, gated: false }, transpose: 0, detune: 0, gainDb10: db10 })
  .chains[0].devices[0].chains[0].devices[0].parameters.Voice_Gain;
check(Math.abs(presetGain(240) / 15.848933219909668 - 1) < 1e-6, 'Voice_Gain +24 dB matches Move: ' + presetGain(240));
check(Math.abs(presetGain(-700) / 0.0003162277571391314 - 1) < 1e-6, 'Voice_Gain -70 dB matches Move: ' + presetGain(-700));
check(presetGain(0) === 1, '0 dB is 1.0');
const presetCell = extra => buildDrumRackPreset(Object.assign({ name: 'c', sampleUri: 'u', frames: 10, starts: [0], ends: [10],
  env: { attackUs: 0, holdUs: -1, decayUs: 0, gated: false }, transpose: 0, detune: 0, gainDb10: 0 }, extra))
  .chains[0].devices[0].chains[0].devices[0].parameters;
for (const [extra, what] of [[{}, 'no crushHz'], [{ crushHz: 0 }, 'crush 0']]) {
  const c = presetCell(extra);
  check(c.Effect_Type === 'Stretch' && c.Effect_StretchFactor === 1 && c.Effect_EightBitResamplingRate === 14080,
        `${what}: effect left at Move's default (Stretch at 1.0)`);
}
check(presetCell({ crushHz: 99999 }).Effect_EightBitResamplingRate === 30000 &&
      presetCell({ crushHz: 5 }).Effect_EightBitResamplingRate === 1000, 'exported rate clamped to 1-30 kHz');
dsp.normGain = 'silent';
tools(); click(); tick(1);
check(printed.includes('Sample is silent') && gainSets().at(-1) === 'gain_db10=127' && log.at(-1) === 'SAY: Sample is silent, nothing to normalize',
      'silent sample: gain left alone');

// ---- Tools > Channels: Mono (L+R) / Left only / Right only / Back ----
tick(200);
const channels = () => { tools(); jog(1); click(); tick(1); };
channels();
check(['Channels', 'Mono (L+R)', 'Left only', 'Right only', 'Back'].every(t => printed.includes(t)), 'Channels submenu: ' + JSON.stringify(printed));
check(log.at(-1) === 'SAY: Channels, Mono (L+R)', 'Channels announced: ' + log.at(-1));
check(!lit(RECORD), 'Channels: Record dark');
midi(0xB0, 51, 127); tick(1);
check(printed.includes('Tools') && printed.includes('Normalize audio') && log.at(-1) === 'SAY: Tools, Channels', 'Back goes up to Tools, on Channels');
midi(0xB0, 51, 127); tick(1);
check(!printed.includes('Tools') && exits() === 2, 'Back again closes Tools');
channels(); jog(3); click(); tick(1);
check(printed.includes('Tools'), 'the Back item goes up to Tools too');
midi(0xB0, 51, 127); tick(1);

// Each choice asks first, starting on No; No and Back cancel
const sentConvert = () => sets.filter(x => x.startsWith('convert_channels='));
for (const [steps, ask, mode] of [[0, 'Make mono?', 'mono'], [1, 'Keep left only?', 'left'], [2, 'Keep right only?', 'right']]) {
  channels(); jog(steps); click(); tick(1);
  check(printed.includes(ask) && printed.includes('Replaces the file') && printed.includes('Yes') && printed.includes('No'), `${mode}: asks "${ask}": ` + JSON.stringify(printed));
  check(log.at(-1) === `SAY: ${ask} Replaces the file, No`, `${mode}: prompt announced on No: ` + log.at(-1));
  click(); tick(1);
  check(!printed.includes(ask) && sentConvert().length === 0 && log.at(-1) === 'SAY: Cancelled', `${mode}: No cancels`);
}
channels(); jog(1); click(); midi(0xB0, 51, 127); tick(1);
check(sentConvert().length === 0 && exits() === 2 && log.at(-1) === 'SAY: Cancelled', 'Back in the prompt cancels');

// Yes: the DSP rewrites the file; wait until it has swapped it in
exportPreset();                                   // start from nothing unexported
midi(0xB0, 51, 127); tick(1);
check(!prompt(), 'nothing unexported before converting');
midi(0xB0, 51, 127); tick(1);
channels(); jog(1); click(); jog(-1); click(); tick(1);
check(sentConvert().at(-1) === 'convert_channels=left', 'Yes sends left: ' + sentConvert().at(-1));
check(printed.includes('Converting...') && !lit(RECORD), 'converting shown, Record dark');
tools();
check(log.at(-1) === 'SAY: Still converting' && !printed.includes('Tools'), 'Tools waits for the conversion');
midi(0xB0, 118, 127); tick(1);
check(!menu() && log.at(-1) === 'SAY: Still converting', 'Export waits for the conversion');
const wavesBeforeConv = waveRequests;
tick(5);
check(printed.includes('Converting...'), 'still converting until the DSP is done');
dsp.convDone = dsp.convReq; dsp.convStatus = 1; dsp.channels = '1'; tick(1);
check(printed.includes('Left only') && log.at(-1) === 'SAY: Now left channel only', 'conversion done: ' + JSON.stringify(printed) + ' ' + log.at(-1));
check(waveRequests > wavesBeforeConv, 'waveform re-read after converting');
check(lit(RECORD), 'Record lit again');
midi(0xB0, 51, 127); tick(1);
check(prompt(), 'converting counts as unexported');
midi(0xB0, 51, 127); tick(1);

// Already 1 channel: says so without opening the submenu
channels();
check(!printed.includes('Mono (L+R)') && printed.includes('Already mono') && log.at(-1) === 'SAY: Sample is already mono', 'mono sample: Already mono');
tick(200);

// The other outcomes
dsp.channels = '2';
for (const [status, text] of [[2, 'Already mono'], [3, 'File is hard-linked'], [0, 'Convert failed']]) {
  channels(); click(); jog(-1); click(); tick(1);
  check(sentConvert().at(-1) === 'convert_channels=mono', 'Yes sends mono');
  dsp.convDone = dsp.convReq; dsp.convStatus = status; tick(1);
  check(printed.includes(text), `status ${status} shows "${text}": ` + JSON.stringify(printed));
  tick(200);
}

// Gain is restored from the DSP's settings (resume); an old ui_state still restores zoom
await freshUi('gainresume');
g.host_tool_reconnect = true;
dsp.settings = '0 -1 50000 0 0 0 -1000 8410';   // an old -inf session: clamped to -70 dB
dsp.uiState = '1 0 2 4';
g.init(); tick(2);
check(lit(DOWN) && !lit(UP), 'an old ui_state resumes on the Main page');
filterPage(); touch(8, true); tick(1);
check(printed.includes('Gain -70.0dB'), 'gain restored from settings, clamped: ' + JSON.stringify(printed));
touch(8, false); touch(3, true); tick(1); touch(3, false);
check(printed.includes('Type Low-Pass 24'), 'settings without filter fields: Low-Pass 24: ' + JSON.stringify(printed));
touch(1, true); tick(1); touch(1, false);
check(printed.includes('Frequency 22.0 kHz'), 'settings without filter fields: fully open: ' + JSON.stringify(printed));
mainPage(); shift(true); touch(2, true); tick(1);
check(printed.includes('Zoom x4'), 'version-1 ui_state still restores zoom: ' + JSON.stringify(printed));
touch(2, false); shift(false); tick(70);
check(Math.max(0, ...waveCols()) === 0, 'waveform flat at -70 dB');
touch(6, true); tick(1); touch(6, false);
check(printed.includes('Effect 8-Bit'), 'effect restored from settings: ' + JSON.stringify(printed));
touch(7, true); tick(1);
check(printed.includes('Rate 8.41 kHz'), 'rate restored from settings: ' + JSON.stringify(printed));
turn(7, 1); tick(1);
check(printed.includes('Rate 8.48 kHz'), 'a restored off-grid 8410 Hz steps to the next step, 8.48 kHz: ' + JSON.stringify(printed));
touch(7, false); tick(70);

// The filter is restored from the DSP's settings too
await freshUi('filterresume');
dsp.settings = '0 -1 50000 0 0 0 0 0 3 12000 450 -60';
dsp.uiState = '3 0 0 1 0';
g.init(); tick(2);
for (const [k, want] of [[1, 'Frequency 1.20 kHz'], [2, 'Peak Gain -6.0dB'], [3, 'Type Peak']]) {
  touch(k, true); tick(1); touch(k, false);
  check(printed.includes(want), `restored: ${want}: ` + JSON.stringify(printed));
}
turn(3, 127); touch(2, true); tick(1); touch(2, false);
check(printed.includes('Resonance 45%'), 'restored resonance, under High-Pass 24: ' + JSON.stringify(printed));
delete g.host_tool_reconnect;

// ---- Filter & Setup page: frequency, resonance / Peak gain, type, mode ----
await freshUi('filter');
dsp.settings = '0 -1 50000 0 0 0 0 0';
dsp.uiState = '';
g.init(); tick(2);
dsp.chop++; tick(70);
exportPreset(); tick(70);
const filterSets = k => sets.filter(x => x.startsWith(k + '='));
// Turn by n detents (CC values 1-63 up, 65-127 down)
const turnBy = (k, n) => { while (n !== 0) { const d = Math.max(-63, Math.min(63, n)); turn(k, d > 0 ? d : 128 + d); n -= d; } };
filterPage(); tick(70);
// Frequency: 30 Hz to 22 kHz, 1/24 octave (Shift 1/96), rounded as Move shows it
mark = sets.length;
touch(1, true); tick(1);
check(printed.includes('Frequency 22.0 kHz') && log.at(-1) === 'SAY: Frequency 22 kilohertz', 'frequency starts fully open: ' + JSON.stringify(printed));
turn(1, 1); tick(1);
check(printed.includes('Frequency 22.0 kHz') && filterSets('filter_hz10').length === 0, 'stops at 22 kHz, sends nothing');
turn(1, 127); tick(1);
check(printed.includes('Frequency 21.7 kHz') && filterSets('filter_hz10').at(-1) === 'filter_hz10=217000', 'one step down: 21.7 kHz: ' + JSON.stringify(printed));
turn(1, 65); turn(1, 65); turn(1, 65); turn(1, 65); tick(1);
check(printed.includes('Frequency 30.0 Hz') && filterSets('filter_hz10').at(-1) === 'filter_hz10=300', 'bottoms out at 30.0 Hz: ' + JSON.stringify(printed));
turn(1, 1); tick(1);
check(printed.includes('Frequency 30.9 Hz'), 'one decimal below 100 Hz: ' + JSON.stringify(printed));
for (const [ticks, want] of [[40, '98.0 Hz'], [1, '101 Hz'], [79, '988 Hz'], [1, '1.02 kHz'], [79, '9.96 kHz'], [1, '10.3 kHz']]) {
  turnBy(1, ticks); tick(1);
  check(printed.includes('Frequency ' + want), `frequency rounding: ${want}: ` + JSON.stringify(printed));
}
turnBy(1, -80); tick(1);                 // 80 steps down: 1.02 kHz
check(printed.includes('Frequency 1.02 kHz'), 'back at 1.02 kHz: ' + JSON.stringify(printed));
shift(true); turn(1, 1); shift(false); tick(1);
check(printed.includes('Frequency 1.03 kHz') && filterSets('filter_hz10').at(-1) === 'filter_hz10=10300', 'Shift: 1/96 octave: ' + JSON.stringify(printed));
touch(1, false); tick(70);
check(log.includes('SAY: Frequency 1.03 kilohertz'), 'frequency announced: ' + log.slice(-2));
// Resonance: 0-90%, 1% steps (Shift 0.1%), one decimal below 10
touch(2, true); tick(1);
check(printed.includes('Resonance 0.0%') && log.at(-1) === 'SAY: Resonance 0.0 percent', 'resonance starts at 0.0%: ' + JSON.stringify(printed));
turn(2, 5); tick(1);
check(printed.includes('Resonance 5.0%') && filterSets('filter_res').at(-1) === 'filter_res=50', 'resonance 5.0%: ' + JSON.stringify(printed));
turn(2, 5); tick(1);
check(printed.includes('Resonance 10%'), 'no decimal from 10%: ' + JSON.stringify(printed));
shift(true); turn(2, 127); shift(false); tick(1);
check(printed.includes('Resonance 9.9%') && filterSets('filter_res').at(-1) === 'filter_res=99', 'Shift: 0.1%: ' + JSON.stringify(printed));
turn(2, 63); turn(2, 63); tick(1);
check(printed.includes('Resonance 90%') && filterSets('filter_res').at(-1) === 'filter_res=900', 'tops out at 90%: ' + JSON.stringify(printed));
turn(2, 65); tick(1);                    // 63 down: 27%
turn(2, 110); tick(1);                   // 18 more: 9.0%? no: 27 - 18 = 9
check(printed.includes('Resonance 9.0%') && filterSets('filter_res').at(-1) === 'filter_res=90', 'resonance 9.0%: ' + JSON.stringify(printed));
touch(2, false); tick(70);
// Type: Low-Pass 12, Low-Pass 24, High-Pass 24, Peak; stops at both ends
touch(3, true); tick(1);
check(printed.includes('Type Low-Pass 24') && log.at(-1) === 'SAY: Filter low-pass 24', 'type starts at Low-Pass 24: ' + JSON.stringify(printed));
turn(3, 127); tick(1);
check(printed.includes('Type Low-Pass 12') && filterSets('filter_type').at(-1) === 'filter_type=0', 'Low-Pass 12: ' + JSON.stringify(printed));
const typeSets = filterSets('filter_type').length;
turn(3, 127); tick(1);
check(printed.includes('Type Low-Pass 12') && filterSets('filter_type').length === typeSets, 'stops at Low-Pass 12, sends nothing');
turn(3, 2); tick(1);
check(printed.includes('Type High-Pass 24') && filterSets('filter_type').at(-1) === 'filter_type=2', 'High-Pass 24: ' + JSON.stringify(printed));
turn(3, 5); tick(1);
check(printed.includes('Type Peak') && filterSets('filter_type').at(-1) === 'filter_type=3', 'stops at Peak: ' + JSON.stringify(printed));
touch(3, false); tick(70);
check(log.includes('SAY: Filter peak'), 'type announced');
// Peak: Knob 2 is Peak Gain, -12 to +12 dB, 0.5 dB steps (Shift 0.1); resonance is kept
touch(2, true); tick(1);
check(printed.includes('Peak Gain 0.0dB') && log.at(-1) === 'SAY: Peak gain 0.0 decibels', 'on Peak, Knob 2 is Peak Gain: ' + JSON.stringify(printed));
turn(2, 6); tick(1);
check(printed.includes('Peak Gain +3.0dB') && filterSets('filter_peak_db10').at(-1) === 'filter_peak_db10=30', 'Peak Gain +3.0dB: ' + JSON.stringify(printed));
shift(true); turn(2, 1); shift(false); tick(1);
check(printed.includes('Peak Gain +3.1dB'), 'Shift: 0.1 dB: ' + JSON.stringify(printed));
turn(2, 63); tick(1);
check(printed.includes('Peak Gain +12.0dB') && filterSets('filter_peak_db10').at(-1) === 'filter_peak_db10=120', 'tops out at +12 dB');
turn(2, 65); tick(1);
check(printed.includes('Peak Gain -12.0dB') && filterSets('filter_peak_db10').at(-1) === 'filter_peak_db10=-120', 'bottoms out at -12 dB');
turn(2, 30); tick(1);
check(printed.includes('Peak Gain +3.0dB'), 'back to +3.0 dB: ' + JSON.stringify(printed));
check(filterSets('filter_res').at(-1) === 'filter_res=90', 'Peak Gain leaves the resonance alone');
touch(2, false); turn(3, 126); touch(2, true); tick(1); touch(2, false);
check(printed.includes('Resonance 9.0%'), 'Low-Pass 24 again: resonance kept: ' + JSON.stringify(printed));
// Mode: Trigger / Gate; Mute stays dark either way
touch(4, true); tick(1);
check(printed.includes('Mode Trigger') && !lit(MUTE), 'Mode starts on Trigger: ' + JSON.stringify(printed));
turn(4, 1); tick(1);
check(printed.includes('Mode Gate') && sets.at(-1) === 'gate=1' && !lit(MUTE), 'Mode Gate: gated');
touch(4, false); tick(70);
check(log.includes('SAY: Mode gate'), 'Mode Gate announced: ' + log.slice(-2));
touch(4, true); tick(1);
const gateSets = sets.filter(x => x.startsWith('gate=')).length;
turn(4, 1); tick(1);
check(sets.filter(x => x.startsWith('gate=')).length === gateSets, 'right of Gate stays Gate, sends nothing');
turn(4, 127); tick(1);
check(printed.includes('Mode Trigger') && sets.at(-1) === 'gate=0', 'Mode Trigger: one-shot again');
touch(4, false); tick(70);
// Knobs 5-7 are not used on this page
mark = sets.length;
for (const k of [5, 6, 7]) {
  touch(k, true); turn(k, 3); tick(1); touch(k, false);
  check(printed.includes('-'), `Filter & Setup Knob ${k} shows "-"`);
}
check(sets.slice(mark).every(s => s.startsWith('ui_state=')), 'Knobs 5-7 send nothing');
tick(70);
// A filter change counts as unexported, and the Drum Preset carries it
midi(0xB0, 51, 127); tick(1);
check(printed.includes('Not exported'), 'a filter change counts as unexported');
midi(0xB0, 51, 127); tick(1);
exportPreset();
{
  const fp = newestPreset().chains[0].devices[0].chains[0].devices[0].parameters;
  check(fp.Voice_Filter_Type === 'Lowpass' && fp.Voice_Filter_Frequency === 1030 && Math.abs(fp.Voice_Filter_Resonance - 0.09) < 1e-12 &&
        Math.abs(fp.Voice_Filter_PeakGain - Math.pow(10, 3 / 20)) < 1e-12 && fp.Voice_Filter_On === true,
        'Drum Preset carries the filter: ' + [fp.Voice_Filter_Type, fp.Voice_Filter_Frequency, fp.Voice_Filter_Resonance, fp.Voice_Filter_PeakGain]);
}
mainPage(); tick(70);

// Filter export: Move's strings and units, from a Move set (tests/fixtures)
const filterFixture = JSON.parse(fs.readFileSync(path.join(repo, 'tests/fixtures/drum_sampler_filter.json'), 'utf8')).cells;
const cellWith = filter => presetCell({ filter });
filterFixture.forEach((c, type) => {
  check(cellWith({ type }).Voice_Filter_Type === c.parameters.Voice_Filter_Type, `type ${type} (${c.moveShows}) writes "${c.parameters.Voice_Filter_Type}"`);
});
{
  const d = presetCell({}), lp24 = filterFixture[1].parameters;
  check(d.Voice_Filter_Type === lp24.Voice_Filter_Type && d.Voice_Filter_Frequency === lp24.Voice_Filter_Frequency &&
        d.Voice_Filter_Resonance === lp24.Voice_Filter_Resonance && d.Voice_Filter_PeakGain === lp24.Voice_Filter_PeakGain &&
        d.Effect_EightBitFilterDecay === lp24.Effect_EightBitFilterDecay, 'no filter: Move\'s default Low-Pass 24, as today');
  const z = cellWith({ type: 1, hz: 22000, res: 0, peakDb: 0 });
  check(JSON.stringify(z) === JSON.stringify(d), 'the default filter exports byte for byte what no filter does');
}
check(cellWith({ type: 0, hz: 30 }).Voice_Filter_Frequency === filterFixture[0].parameters.Voice_Filter_Frequency, 'lowest frequency 30 Hz, as Move');
check(cellWith({ hz: 5 }).Voice_Filter_Frequency === 30 && cellWith({ hz: 99999 }).Voice_Filter_Frequency === 22000, 'frequency clamped to 30 Hz-22 kHz');
check(Math.abs(cellWith({ res: 0.9 }).Voice_Filter_Resonance - filterFixture[3].parameters.Voice_Filter_Resonance) < 1e-7 &&
      cellWith({ res: 2 }).Voice_Filter_Resonance === 0.9, 'resonance 0.9 is the top, as Move');
check(cellWith({ peakDb: 0 }).Voice_Filter_PeakGain === 1, 'Peak Gain 0 dB writes 1.0');
check(Math.abs(cellWith({ peakDb: 12 }).Voice_Filter_PeakGain - 3.981071705534973) < 1e-12 &&
      Math.abs(cellWith({ peakDb: -12 }).Voice_Filter_PeakGain - 0.251188643150958) < 1e-12 &&
      Math.abs(cellWith({ peakDb: 99 }).Voice_Filter_PeakGain - 3.981071705534973) < 1e-12, 'Peak Gain is linear, clamped to +-12 dB');

// help.json: lines of 20 characters or fewer
const help = JSON.parse(fs.readFileSync(path.join(repo, 'src/help.json'), 'utf8'));
(function walkHelp(node) {
  (node.lines || []).forEach(l => check(l.length <= 20, `help line over 20 characters: "${l}"`));
  (node.children || []).forEach(walkHelp);
})(help);

console.log(log.filter(l => /Export|Saved/.test(l)).join('\n'));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
