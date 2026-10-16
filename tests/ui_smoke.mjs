// Smoke test for src/ui.js: runs it under node with a fake host and a fake
// DSP, then drives init/tick/MIDI. Catches syntax and runtime errors before a
// device build. Needs ../schwung for the shared modules.
//
//   node tests/ui_smoke.mjs
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const shared = path.resolve(repo, '../schwung/src/shared');
const dir = path.join(repo, 'build');
fs.mkdirSync(dir, { recursive: true });
let src = fs.readFileSync(path.join(repo, 'src/ui.js'), 'utf8');
src = src.replaceAll('/data/UserData/schwung/shared/', pathToFileURL(shared).href + '/');
fs.writeFileSync(path.join(dir, 'ui_under_test.mjs'), src);

const log = [];
const g = globalThis;
for (const f of ['clear_screen','print','set_pixel','draw_rect','fill_rect','draw_line'])
  g[f] = (...a) => { if (a.some(v => typeof v === 'number' && !Number.isFinite(v))) throw new Error(f + ' got non-finite ' + JSON.stringify(a)); };
let printed = [];
g.print = (x, y, t) => { if (typeof t !== 'string') throw new Error('print non-string'); printed.push(t); };
g.text_width = t => t.length * 5;
g.move_midi_internal_send = () => {};
g.host_send_screenreader = t => log.push('SAY: ' + t);
g.host_announce_screenreader = g.host_send_screenreader;
g.shadow_get_display_mode = () => 1;
g.host_exit_module = () => log.push('EXIT');
g.host_tool_file_path = '/data/UserData/UserLibrary/Samples/test loop.wav';

// Fake DSP state
const dsp = { frames: 441000, rate: 44100, playing: 0, pos: 0, starts: [0], ends: [441000], sel: 0,
  settings: '0 -1 50000 0', chop: 0, undo: 0, depth: 0 };
const sets = [];
g.host_module_get_param = k => {
  if (k === 'status') return `ready ${dsp.frames} ${dsp.rate} ${dsp.playing} ${dsp.pos}`;
  if (k === 'slices') return [dsp.chop, dsp.undo, dsp.depth, dsp.playing ? 0 : -1, dsp.sel, dsp.starts.length,
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

g.init(); tick(5);
// chop into 3 slices
dsp.starts = [0, 100000, 200000]; dsp.ends = [100000, 200000, 441000]; dsp.chop = 2; dsp.depth = 2; dsp.sel = 1;
tick(2);
// touch each knob, turn, release
for (let k = 0; k < 8; k++) {
  midi(0x90, k, 127); tick(1);
  const shown = printed.find(t => /Start|End|Zoom|Scale|Attack|Hold|Decay|Transpose/.test(t));
  midi(0xB0, 71 + k, 3); tick(1);
  const after = printed.find(t => /Start|End|Zoom|Scale|Attack|Hold|Decay|Transpose/.test(t));
  midi(0x90, k, 0); tick(70);
  console.log(`knob ${k + 1}: touch="${shown}" turned="${after}"`);
}
midi(0xB0, 14, 1); midi(0xB0, 3, 127); midi(0xB0, 62, 127); midi(0xB0, 56, 127); tick(30);
midi(0xB0, 51, 127);
console.log('set_params:', sets.join(' | '));
console.log(log.join('\n'));
