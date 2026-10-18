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
  normGain: '0' };
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
  if (k === 'export_result') return `${dsp.exportReq} ${dsp.exportDone} ${dsp.exportWritten}`;
  return null;
};
const fakeSet = (k, v) => {
  sets.push(k + '=' + v);
  if (k === 'export_slices') dsp.exportReq++;
  if (k === 'ui_state') dsp.uiState = v;
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
const READOUT = /Start|End|Zoom|Gain|Attack|Hold|Decay|Transpose/;

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

// Zoom centers on the selected slice's start, even with the end marker active
midi(0x90, 1, 127); midi(0x90, 1, 0);           // touch knob 2: end marker active
midi(0xB0, 73, 5); tick(1);                      // zoom in
{
  const [, from, to] = lastWave, mid = (from + to) / 2;
  check(from <= 100000 && to > 100000 && Math.abs(mid - 100000) <= 2,
        'zoom centers on the start marker, not the end: ' + from + '-' + to);
}
// Touching the zoom knob alone recenters on the start
midi(0x90, 1, 127); midi(0xB0, 72, 120); midi(0x90, 1, 0); tick(1);   // move the end: view follows it
check(lastWave[1] > 100000, 'moving the end scrolls the view to it: ' + lastWave[1] + '-' + lastWave[2]);
midi(0x90, 2, 127); tick(1); midi(0x90, 2, 0);
{
  const [, from, to] = lastWave, mid = (from + to) / 2;
  check(Math.abs(mid - 100000) <= 2, 'touching zoom recenters on the start: ' + from + '-' + to);
}
// Selecting a short slice with the end marker active still shows its start
dsp.starts = [0, 100000, 130000]; dsp.ends = [100000, 130000, 441000]; dsp.sel = 0; tick(1);
midi(0xB0, 73, 7); tick(1);                                         // zoom x8: view ~55k frames
midi(0x90, 0, 127); midi(0x90, 0, 0); midi(0x90, 1, 127); midi(0x90, 1, 0); tick(1);   // end active
check(lastWave[1] > 50000, 'end marker active and in view: ' + lastWave[1] + '-' + lastWave[2]);
tick(70);
check(printed.some(t => t.startsWith('S 0.000s ')), 'bottom line shows the start even with the end active: ' + JSON.stringify(printed));
dsp.sel = 1; tick(1);                                               // play pad 2
check(lastWave[1] <= 100000 && lastWave[2] >= 130000, 'selected slice start and end both shown: ' + lastWave[1] + '-' + lastWave[2]);
dsp.sel = 2; tick(1);                                               // long slice: start wins
check(lastWave[1] <= 130000 && lastWave[2] > 130000, 'long slice shows its start: ' + lastWave[1] + '-' + lastWave[2]);
midi(0xB0, 73, 121); tick(1);
dsp.starts = [0, 100000, 200000]; dsp.ends = [100000, 200000, 441000]; dsp.sel = 1; tick(1);
midi(0xB0, 73, 123); midi(0x90, 0, 127); midi(0x90, 0, 0); tick(70);   // zoom back out, start active

let mark;
// Knob touch shows a readout, turning updates it
for (let k = 0; k < 8; k++) {
  midi(0x90, k, 127); tick(1);
  const shown = printed.find(t => READOUT.test(t));
  midi(0xB0, 71 + k, 3); tick(1);
  const after = printed.find(t => READOUT.test(t));
  midi(0x90, k, 0); tick(70);
  check(shown, `knob ${k + 1} touch shows a readout`);
  console.log(`knob ${k + 1}: touch="${shown}" turned="${after}"`);
}

// Knob 4 is Gain: 0.5 dB steps (Shift 0.1) from -24 dB up, 2 dB below, -70 to +24 dB
const gainSets = () => sets.filter(x => x.startsWith('gain_db10='));
midi(0x90, 3, 127); tick(1);
midi(0xB0, 74, 127); tick(1);                       // knob loop left it at +1.5 dB
check(printed.includes('Gain +1.0dB') && gainSets().at(-1) === 'gain_db10=10', 'one step down is 0.5 dB: ' + JSON.stringify(printed));
midi(0xB0, 49, 127); midi(0xB0, 74, 1); midi(0xB0, 49, 0); tick(1);
check(printed.includes('Gain +1.1dB'), 'Shift: 0.1 dB steps: ' + JSON.stringify(printed));
midi(0xB0, 74, 63); tick(1);
check(printed.includes('Gain +24.0dB') && gainSets().at(-1) === 'gain_db10=240', 'tops out at +24 dB');
midi(0xB0, 74, 65); midi(0xB0, 74, 65); tick(1);   // 126 steps down
check(printed.includes('Gain -70.0dB') && gainSets().at(-1) === 'gain_db10=-700', 'bottoms out at -70 dB: ' + JSON.stringify(printed));
midi(0xB0, 74, 23); tick(1);                       // 23 x 2 dB = -24 dB
check(printed.includes('Gain -24.0dB'), '2 dB steps below -24 dB: ' + JSON.stringify(printed));
midi(0xB0, 74, 2); tick(1);
check(printed.includes('Gain -23.0dB'), '0.5 dB steps from -24 dB up: ' + JSON.stringify(printed));
midi(0xB0, 74, 46); tick(1);
check(printed.includes('Gain 0.0dB'), 'back to 0 dB: ' + JSON.stringify(printed));
midi(0x90, 3, 0); tick(70);
check(log.includes('SAY: Gain 0.0 decibels'), 'gain spoken: ' + log.slice(-3));

// The waveform is drawn at the gained level
// Waveform columns are centred on the wave's midline (markers run top to bottom)
const WAVE_MID_Y = 28, WAVE_HALF_H = 18;   // ui.js WAVE_MID / WAVE_HALF; fake peaks are 0xa0
const waveCols = () => vlines.filter(l => l.mid === WAVE_MID_Y && l.len < 40).map(l => l.len);
const waveH = () => { tick(1); return Math.max(0, ...waveCols()); };
const waveWant = db => 2 * Math.min(WAVE_HALF_H, Math.round(0xa0 * Math.pow(10, db / 20) * WAVE_HALF_H / 255));
check(waveH() === waveWant(0), `waveform at 0 dB: ${waveH()} vs ${waveWant(0)}`);
midi(0xB0, 74, 6); tick(70);                       // +3 dB
check(waveH() === waveWant(3) && waveWant(3) > waveWant(0), `waveform taller at +3 dB: ${waveH()} vs ${waveWant(3)}`);
midi(0xB0, 74, 6); tick(70);                       // +6 dB: past the edge
check(waveH() === 2 * WAVE_HALF_H, 'a boost flattens at the edges: ' + waveH());
midi(0xB0, 74, 116); tick(70);                     // back to 0 dB

// Shift + Knob 8 is detune in cents (-50 to +50), leaving transpose alone
mark = sets.length;
midi(0xB0, 49, 127); midi(0x90, 7, 127); tick(1);
check(printed.includes('Detune 0ct'), 'Shift + touching Knob 8 shows detune: ' + JSON.stringify(printed));
midi(0xB0, 78, 5); tick(1);
check(printed.includes('Detune +5ct'), 'Shift + Knob 8 turns detune: ' + JSON.stringify(printed));
check(sets.slice(mark).includes('detune=5') && !sets.slice(mark).some(s => s.startsWith('transpose=')),
      'detune sent, transpose untouched: ' + JSON.stringify(sets.slice(mark)));
midi(0xB0, 78, 63); tick(1);
check(printed.includes('Detune +50ct') && sets.at(-1) === 'detune=50', 'detune clamps at +50');
midi(0xB0, 78, 65); midi(0xB0, 78, 65); tick(1);
check(printed.includes('Detune -50ct') && sets.at(-1) === 'detune=-50', 'detune clamps at -50');
midi(0xB0, 78, 20); tick(1);
check(sets.at(-1) === 'detune=-30', 'detune back to -30: ' + sets.at(-1));
midi(0x90, 7, 0); midi(0xB0, 49, 0); tick(70);
check(log.some(l => l === 'SAY: Detune -30 cents'), 'detune announced');
midi(0x90, 7, 127); tick(1);
check(printed.some(t => t.startsWith('Transpose')), 'without Shift, Knob 8 is transpose again');
midi(0x90, 7, 0); tick(70);

// Top bar is just the pad; zoom, transpose and Start/End stay off it
tick(1);
check(printed[0] === 'Pad 2/3', `top bar shows only the pad (got "${printed[0]}")`);
check(!printed.some(t => /x\d|st\b|START|END/.test(t)), 'no zoom/transpose/START/END when idle: ' + JSON.stringify(printed));

// The jog only ever moves the start, even after touching the end knob
midi(0x90, 1, 127); tick(1); midi(0x90, 1, 0);
mark = sets.length;
midi(0xB0, 3, 127); midi(0xB0, 14, 1); tick(1);
check(sets.slice(mark).some(s => /^nudge=\d+ 0 \d+$/.test(s)) && !sets.slice(mark).some(s => /^nudge=\d+ 1 /.test(s)),
      'jog nudges the start: ' + JSON.stringify(sets.slice(mark)));

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

// ---- Mute: one-shot (lit) / gated (dark) ----
check(lit(MUTE), 'Mute lit: one-shot by default');
mark = sets.length;
midi(0xB0, 88, 127); tick(1);
check(sets.slice(mark).includes('gate=1'), 'Mute sends gate=1');
check(!lit(MUTE), 'Mute dark when gated');
check(printed.includes('Gated') && log.at(-1) === 'SAY: Gated: plays while held', 'gated shown on the bottom line and spoken');
midi(0xB0, 118, 127); tick(1);
check(!lit(MUTE), 'Mute dark in the export menu');
mark = sets.length;
midi(0xB0, 88, 127); tick(1);
check(sets.slice(mark).length === 0, 'Mute ignored in the export menu');
jog(1); click(); tick(2);
const gatedPreset = JSON.parse(files[presetDir + 'test loop Chop 3.ablpreset'] || '{}');
check(gatedPreset.chains && gatedPreset.chains[0].devices[0].chains[0].devices[0].parameters.Voice_Envelope_Mode === 'A-S-R',
      'gated exports as A-S-R');
mark = sets.length;
midi(0xB0, 88, 127); tick(1);
check(sets.slice(mark).includes('gate=0') && lit(MUTE), 'Mute again: one-shot, lit');
check(printed.includes('One-shot') && log.at(-1) === 'SAY: One-shot', 'one-shot shown and spoken');

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
midi(0xB0, 73, 5); tick(1);                       // zoom in: remembered
dsp.chop = 7; tick(1);                            // unexported work
check(/^2 1 [\d.]+$/.test(dsp.uiState) && dsp.uiState !== '2 1 0', 'ui_state saved as it changes: ' + dsp.uiState);
mark = sets.length;
midi(0xB0, 51, 127); click(); tick(1);       // the default: Keep for later
const keptState = dsp.uiState;
check(log.includes('HIDE') && exits() === 2, 'Keep for later hides instead of exiting');
check(sets.slice(mark).includes('stop=1'), 'Keep for later stops the voice');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD) && !lit(MUTE), 'hiding turns the buttons off');
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
check(dsp.uiState === keptState, 'zoom and unexported restored on resume: ' + dsp.uiState + ' vs ' + keptState);
check(lit(MUTE) && lit(RECORD), 'buttons lit again after resuming');
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

// ---- Tools menu (Shift + jog click): Normalize audio / Back ----
tick(70);
const tools = () => { midi(0xB0, 49, 127); click(); midi(0xB0, 49, 0); tick(1); };
tools();
check(printed.includes('Tools') && printed.includes('Normalize audio') && printed.includes('Back'), 'Shift + jog click opens Tools: ' + JSON.stringify(printed));
check(log.at(-1) === 'SAY: Tools, Normalize audio', 'Tools announced');
check(!lit(UNDO) && !lit(DELETE) && !lit(RECORD), 'Tools: buttons dark');
mark = sets.length;
midi(0xB0, 71, 5); midi(0x90, 4, 127); midi(0xB0, 118, 127); tick(1);
check(printed.includes('Tools') && !sets.slice(mark).some(s => !s.startsWith('ui_state=')), 'knobs and Record ignored in Tools');
jog(1); click(); tick(1);
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
midi(0x90, 3, 127); tick(1);
check(printed.includes('Gain +12.7dB'), 'Knob 4 shows the normalized gain');
midi(0xB0, 74, 1); tick(1);
check(printed.includes('Gain +13.2dB'), 'and turns on from it');
midi(0xB0, 74, 127); midi(0x90, 3, 0); tick(70);
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
dsp.normGain = 'silent';
tools(); click(); tick(1);
check(printed.includes('Sample is silent') && gainSets().at(-1) === 'gain_db10=127' && log.at(-1) === 'SAY: Sample is silent, nothing to normalize',
      'silent sample: gain left alone');

// Gain is restored from the DSP's settings (resume); an old ui_state still restores zoom
await freshUi('gainresume');
g.host_tool_reconnect = true;
dsp.settings = '0 -1 50000 0 0 0 -1000';    // an old -inf session: clamped to -70 dB
dsp.uiState = '1 0 2 4';
g.init(); tick(2);
midi(0x90, 3, 127); tick(1);
check(printed.includes('Gain -70.0dB'), 'gain restored from settings, clamped: ' + JSON.stringify(printed));
midi(0x90, 3, 0); midi(0x90, 2, 127); tick(1);
check(printed.includes('Zoom x4'), 'version-1 ui_state still restores zoom: ' + JSON.stringify(printed));
midi(0x90, 2, 0); tick(70);
check(Math.max(0, ...waveCols()) === 0, 'waveform flat at -70 dB');
delete g.host_tool_reconnect;

console.log(log.filter(l => /Export|Saved/.test(l)).join('\n'));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
