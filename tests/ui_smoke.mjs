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
for (const f of ['clear_screen', 'set_pixel', 'draw_rect', 'fill_rect', 'draw_line'])
  g[f] = (...a) => { if (a.some(v => typeof v === 'number' && !Number.isFinite(v))) throw new Error(f + ' got non-finite ' + JSON.stringify(a)); };
let printed = [];
g.print = (x, y, t) => { if (typeof t !== 'string') throw new Error('print non-string'); printed.push(t); };
g.text_width = t => t.length * 5;
g.move_midi_internal_send = () => {};
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
  settings: '0 -1 50000 0', chop: 0, undo: 0, del: 0, depth: 0 };
const sets = [];
g.host_module_get_param = k => {
  if (k === 'status') return `ready ${dsp.frames} ${dsp.rate} ${dsp.playing} ${dsp.pos}`;
  if (k === 'slices') return [dsp.chop, dsp.undo, dsp.del, dsp.depth, dsp.playing ? 0 : -1, dsp.sel, dsp.starts.length,
    ...dsp.starts.flatMap((s, i) => [s, dsp.ends[i]])].join(' ');
  if (k === 'settings') return dsp.settings;
  if (k.startsWith('wave ')) { const c = +k.split(' ')[3]; return 'a0'.repeat(c); }
  if (k === 'error') return '';
  return null;
};
g.host_module_set_param = (k, v) => sets.push(k + '=' + v);
g.host_module_set_param_blocking = (k, v) => { sets.push(k + '=' + v); return true; };

await import(pathToFileURL(path.join(dir, 'ui_under_test.mjs')).href);
const tick = n => { for (let i = 0; i < n; i++) { printed = []; g.tick(); } };
const midi = (s, d1, d2) => g.onMidiMessageInternal([s, d1, d2]);
const READOUT = /Start|End|Zoom|Scale|Attack|Hold|Decay|Transpose/;

g.init(); tick(5);
// Three slices
dsp.starts = [0, 100000, 200000]; dsp.ends = [100000, 200000, 441000]; dsp.chop = 2; dsp.depth = 2; dsp.sel = 1;
tick(2);

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

// Other controls run without throwing
midi(0xB0, 14, 1); midi(0xB0, 3, 127); midi(0xB0, 62, 127); midi(0xB0, 56, 127); tick(30);

// ---- Export ----
const settingSets = Object.fromEntries(sets.filter(s => /^(attack_us|hold_us|decay_us|transpose)=/.test(s)).map(s => s.split('=')));
midi(0xB0, 52, 127); tick(2);          // Capture
midi(0xB0, 52, 127); tick(2);          // again: must not overwrite
const presetDir = '/data/UserData/UserLibrary/Track Presets/';
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
  });
  const c0 = rack.chains[0].devices[0].parameters;
  console.log(`export: attack=${c0.Voice_Envelope_Attack}s hold=${c0.Voice_Envelope_Hold}s decay=${c0.Voice_Envelope_Decay}s transpose=${c0.Voice_Transpose}`);

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
let mark = sets.length;
midi(0xB0, 119, 127); tick(1);
check(sets.slice(mark).includes('delete=' + dsp.sel), 'Delete sends the selected slice');
dsp.del = 1; dsp.starts = [0, 200000]; dsp.ends = [200000, 441000]; dsp.sel = 0; tick(2);
check(log.some(l => l.startsWith('SAY: Deleted, Pad 1 selected, 2 slices')), 'delete announced');

// ---- Exit prompt ----
const exits = () => log.filter(l => l === 'EXIT').length;
const prompt = () => printed.includes('Not exported');
midi(0xB0, 51, 127); tick(1);
check(prompt() && exits() === 0, 'Back with unexported changes asks first');
mark = sets.length;
midi(0xB0, 71, 5); midi(0x90, 4, 127); tick(1);
check(prompt() && sets.length === mark, 'knobs ignored while asking');
midi(0xB0, 51, 127); tick(1);
check(!prompt() && exits() === 0, 'Back in the prompt cancels');
midi(0xB0, 51, 127); midi(0xB0, 14, 1); midi(0xB0, 14, 1); midi(0xB0, 3, 127); tick(1);
check(!prompt() && exits() === 0, 'choosing Cancel stays');
midi(0xB0, 51, 127); midi(0xB0, 14, 1); midi(0xB0, 3, 127); tick(1);
check(exits() === 1, 'choosing Exit, discard exits');
const p3 = presetDir + 'test loop Chop 3.ablpreset';
dsp.chop = 3; tick(1);                   // more unexported work
midi(0xB0, 51, 127); midi(0xB0, 52, 127); tick(1);
check(p3 in files && exits() === 2, 'Capture in the prompt exports, then exits');
midi(0xB0, 51, 127); tick(1);
check(!prompt() && exits() === 3, 'Back exits straight away when everything is exported');

console.log(log.filter(l => /Export|Saved/.test(l)).join('\n'));
console.log(failures ? `${failures} FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
