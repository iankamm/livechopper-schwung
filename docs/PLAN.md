# LiveChopper plan

Work that isn't built yet. [SPEC.md](SPEC.md) describes what the module does
today; when something here is built, its decisions move into SPEC.md and it
comes off this list. What was measured along the way goes to
[NOTES.md](NOTES.md).

## Match the drum sampler effects to Move

Steps 1-3 are done: one knob model for every knob that mirrors Move (SPEC
"Knob model"), and the Effect knob with Move's nine effects, each with a
stand-in in chop mode (SPEC "Effect"). What they were built from is in
NOTES "Move's Drum Sampler, measured".

Step 4, still open: tune each stand-in to Move. Apart from Punch they are
LiveChopper's own designs, not Move's algorithms.

### Status

- Done: Punch (2026-11-12). Acceptance Set 31, seed 1112, references in
  `tests/move_refs/punch/`; measurements and model in NOTES "Punch". Its
  listening A/B is still owed: Punch was done before that step was
  added, and needs a preview take of Set 31's pads to compare.
- Done: Pitch Env (2026-11-13). Fitted on Set 32, acceptance Set 33,
  seed 1113, references in `tests/move_refs/pitch_env/`; preview checks,
  `device-check` and listening A/B passed (2026-11-13: a subtle onset
  difference heard on 7 of 10 pairs, the dry pair too, Move named at
  chance, all accepted). NOTES "Pitch Env".
- Fitted: FM (2026-11-13, Set 34, NOTES "FM"): 15 of 16, pad 9's one
  band window, accepted 2026-11-14. Acceptance Set 36 (seed 1114,
  `tools/fxlab/sets/set36_fm_accept.json`) failed on pad 11 and became a
  fit Set (NOTES "FM"). Accepted 2026-11-14 on Set 37 (seed 1115,
  `tools/fxlab/sets/set37_fm_accept.json`): 16 of 16, references in
  `tests/move_refs/fm/`. Owed: preview, device-check and listening A/B.
- Done: the volume envelope's Decay and Gate release (2026-11-14, Set 35,
  NOTES "Volume envelope"): -84 dB over the Decay, a straight line in dB.
  References in `tests/move_refs/envelope/`.
- Then, in this order: FM's acceptance, Ring Mod's decay, Sub Osc and
  Noise's envelopes, following Transpose, 8-Bit, Stretch, Loop. Sets
  are written with `fxlab.py make-set` from a spec in `tools/fxlab/sets/`.
- Following Transpose, already seen: Move's Attack follows it (Set 32 pad
  15: 1.0 ms at +12 st ramps in ~22 frames), Pitch Env's Decay and
  Punch's times don't. Hold and Decay are unchecked.

### What Live's manual says

Live's Drum Sampler is the same device as Move's, and its manual the only
description of each effect, against LiveChopper's stand-ins:

| Effect | Live's manual | Stand-in today |
|---|---|---|
| Stretch | "changes the sample's length without altering its pitch"; Factor "a multiple of the original playback speed", Grain Size in ms | two Hann grains half a grain apart (NOTES "Stretch and Loop stand-ins") |
| Loop | "repeats a portion of the sample"; Offset "the loop start point relative to the sample start", Length in ms | repeats from Offset, a 1.5 ms dip at each wrap |
| Pitch Env | -100 to 100 % | matched to Move (48 semitones at 100 %) |
| Punch | ducking with a fixed attack, emphasising the transient; Release is how long the gain reduction takes to return | matched to Move |
| 8-Bit | "a combination of filtering, bit reduction, and sample rate reduction"; Decay is the low-pass's decay | sample-and-hold, 8 bits, a low-pass closing to 200 Hz |
| FM, Ring Mod | the modulation decays with the global Decay ("with short decay times, the modulation applies only to the transient") | constant modulation |
| Sub Osc, Noise | their envelope is "the device's attack and decay settings" (Hold isn't mentioned: they may decay even at Hold Inf) | both go through the voice's whole envelope, Hold included; Noise also follows the sound's level, which Move may not |
| Stretch, Loop, FM, Ring Mod, Sub Osc, Noise | time and frequency settings follow the global pitch and the note | fixed (only Loop Length follows Transpose) |

Live's Drum Sampler reference also has "Envelope Follows Pitch", a
context-menu option scaling the amplitude envelope with the pitch. Move
has no knob for it, but its presets store it as
`Voice_PitchToEnvelopeModulation`: true on every pad of Set 28 (Move's
default), and LiveChopper's export writes true too (`src/drum_rack.mjs`).
LiveChopper's envelope runs in output time, so it doesn't follow pitch.
Punch's times don't follow Transpose (Set 31), nor does Pitch Env's Decay,
but the Attack does (Set 32, NOTES "Pitch Env"); the Transpose +12 takes
of "What to record" show what else does.

### Method

Copies of Move's manual and of Live's Drum Sampler reference are in
`.claude/ref/`, local only. The analysis runs with `build/.venv/bin/python`,
set up by `tools/fxlab/setup_env.sh` (numpy, scipy and matplotlib,
pinned in `tools/fxlab/requirements.txt`).

1. Copy the test sounds (below) to the Move, into
   `/data/UserData/UserLibrary/Samples/LiveChopper Tests/`.
2. Build test Sets on Move: each pad gets a test sound and one row's
   settings from "What to record" (each pad keeps its own effect settings,
   so one Drum Rack holds a group of takes).
3. Record with Schwung's Quantized Sampler (Shift+Sample, source
   Resample): a digital copy of Move's output at unity gain, independent
   of the volume knob, without the metronome, saved as stereo 16-bit
   44.1 kHz WAVs to
   `/data/UserData/UserLibrary/Samples/Schwung/Resampler/<date>/`
   (`schwung/docs/ARCHITECTURE.md`, "Capture path"). Play the pads one at a
   time, in note order, nothing else playing, each after the last has
   ended and at least 0.25 s of silence (about 3 s apart for the 2 s
   sounds), then stop. The take
   starts on a bar; each test sound starts with a step or click, so the
   take is split by onsets. Schwung's Global Settings -> Audio must have
   Move->Schwung On (Move's Link on) and Spkr EQ Off, with no Schwung
   Master FX: the take is then rebuilt from Move's per-track Link Audio
   channels, before Move's master chain (NOTES "Move's dry path" has what
   a take without it went through). The volume knob doesn't matter (the
   same take at two volumes matched).
4. Copy the take and the Set's `Song.abl` to the host, then
   `build/.venv/bin/python tools/fxlab/fxlab.py all <take.wav> <Song.abl>
   <outdir>`. It splits the take at onsets (the k-th onset is the k-th pad
   with a sample, by note, so play the pads in order with at least 0.25 s
   of silence between), saves each pad's settings, renders the same sound
   and settings through plugin.c (`tools/fxlab/fx_render.c`, built into
   `build/fx_render`), lines the two up and compares: level (5 ms RMS),
   pitch (sine_441), read position (position_ramp, to ~0.2 ms), 1/3-octave
   bands over time (noise_white, sweep) and the sample-exact residual.
   Plots go to `<outdir>/plots/`, numbers to `<outdir>/compare.json`. The
   level reference is fitted from the Set's fully dry pads, else Set 28's.
   For Punch, it also renders each pad dry and plots the gain against that
   over time, Move's and ours (sine: a 100-frame window every 10 frames;
   click_train: each click from 100 ms on, since the attack ramp hides the
   one on frame 0), with the deepest cut or boost, when the curve first
   moves 0.5 dB, and how long it takes to come 63 % and 90 % of the way
   back. Move's curve is also saved as `plots/<piece>_gain.txt`. Checked
   on a synthetic take (a known -10 dB duck): depth and recovery times
   come out within a window's width.
5. Read the plots and numbers for what each effect does differently.
6. Tune each stand-in in `src/dsp/plugin.c`, add a frame-by-frame check in
   `tests/dsp_test.c`, and record the decision in NOTES.
7. When it looks right, prove it: `fxlab.py accept-set <effect> --seed
   <n>` draws a held-out acceptance Set, which is recorded and split as
   above, then `fxlab.py check <outdir>`. The effect is done when that
   passes (see "When an effect is done"); `fxlab.py refs <outdir> --seed
   <n>` then saves Move's curves to `tests/move_refs/`, and the seed goes
   under "Status".
8. Then check the preview as the Move plays it. In LiveChopper (a fresh
   session, so the installed `dsp.so` loads), load the test sound and play
   pad 1 once per setting, copying pads of a recorded Set (a dry one
   first), about 3 s apart, then press Shift+Capture: Skipback saves the
   last 30 s (Schwung's default; its settings can lengthen it) to
   `Samples/Schwung/Skipback/<date>/`. At 3 s apart that holds about 10
   pads, so a longer list takes two Skipback takes. The Quantized Sampler
   can't be used here: Schwung arms it only outside its own UI, so inside a
   tool Shift+Sample reaches the tool (`schwung_shim.c`, the sampler's
   `!shadow_display_mode`). Skipback's Shift+Capture is taken by the shim
   everywhere, and a tool's DSP is mixed into the same capture. Then
   `fxlab.py split <skipback.wav> --like <Set outdir>:NN,NN,...
   <preview outdir>`, and two verdicts: `fxlab.py check <preview outdir>`
   (the preview against plugin.c's render: the knobs and the output path)
   and `fxlab.py check <Set outdir> --ours-take <preview outdir>` (Move's
   own effect against the preview as heard on the Move).
9. If plugin.c changed in a way that might compute differently on the
   Move, `fxlab.py device-check <outdirs>`: plugin.c built for the Move
   must compute the host's renders bit for bit.

### When an effect is done

Decided 2026-11-12: an effect is done when a held-out acceptance Set
passes `fxlab.py check`, which means every pad passes every metric that
applies to it, and then, since 2026-11-13, a final listening A/B test
passes (below). The metrics decide pass or fail; the A/B is the last
verification, by ear, that what passed sounds like Move. Each metric is a curve over time from
note-on, Move's against ours, from 1 ms (past the attack ramp) to 20 ms
before the sound ends (clear of Move's end fade), with limits from
hearing thresholds:

| Metric | What it compares | rms | max | Applies to |
|---|---|---|---|---|
| gain | gain against the same pad rendered dry, a 100-frame window every 10 frames | 0.5 dB | 1.5 dB | sine_441(_quiet) under Punch, or Ring Mod below 20 Hz |
| pitch | pitch between zero crossings | 5 ct | 15 ct | sine_441(_quiet) dry, under Punch, Pitch Env, or FM below 20 Hz that doesn't reverse the read (Amount x 10 < 1) |
| position | the frame read, from position_ramp's value | 1 ms | 2 ms | position_ramp dry, under Loop, Pitch Env, or FM below 20 Hz |
| bands | 1/3-octave levels over time (4096-frame windows, hop 1024), cells within 40 dB of the loudest and above -80 dB full scale; both sides clamped at that floor | 1 dB | 3 dB | every pad: the catch-all |

- **Held out:** `accept-set` draws each setting at a random whole number
  of knob clicks (so Move's curves apply), on the effect's test sounds plus
  drum_synth, after tuning, from a seed recorded under "Status". A Set
  that fails becomes one more fit Set, and the next try uses a new seed.
- **Move's repeatability:** pad 1 is dry and the last pad repeats pad 2. A
  metric's limits rise to what Move's two takes differ by, if that's more.
- **Capture ceiling:** with Move->Schwung On, Schwung rebuilds the mix and
  soft-clips it above 29204 (-1.0 dBFS): y = 29204 + 3563 tanh((x -
  29204) / 3563), `mix_soft_clip` in `schwung/src/host/mix_soft_clip.h`.
  Move's takes and the preview's alike are bent above 29204, and full
  scale comes out at exactly 31918, the "ceiling" Sets 29 and 30 hit.
  Test material stays under 29204 in the capture. Check this before
  drawing an acceptance Set.
- **Afterwards:** `fxlab.py refs` saves Move's curves (a point a ms) and
  the limits to `tests/move_refs/<effect>/`, and `scripts/test.sh` runs
  `fxlab.py refs-check`, which renders each pad through plugin.c and
  holds it to them. It also runs `tests/fxlab_selftest.py`, which shows that
  plugin.c's own render passes and that +1 dB or 10 cents fail. Both need the
  analysis venv; without it (CI) they are skipped.
- **Listening A/B, last:** after `check`, the two preview checks (Method
  item 8) and, when it applies, `device-check` pass, the user compares
  Move's own pads with LiveChopper's preview of the same pads: the
  acceptance Set's pieces against the preview take's, split `--like` it.
  Each pair is played A then B, the order drawn at random and not shown
  until the user has answered, both at the same level (each take scaled
  by its own dry pad, since the preview plays 1.45 dB above Move; see
  "Open"), on the same speakers or headphones. For each pair the user
  says whether they hear a difference and, if so, which is Move. It
  passes when no pair has a difference the user wouldn't accept. Anything
  heard goes into NOTES and back to fitting, as a failed Set does. The
  result and its date go under "Status". `fxlab.py ab make <Set outdir>
  <preview outdir>` writes the pairs (one WAV a pad: A, 1 s of silence,
  B) and the key, and `fxlab.py ab score <preview outdir>/ab <answers>
  [--accept N,...]` scores one character a pair: `.` for no difference,
  `A` or `B` for the one heard as Move.
- **Shown so far:** Set 28's dry pads pass every metric with room to spare
  (NOTES "Move's dry path"), and Punch passed on Set 31.
- **Attack:** Move's dry level depends on it (NOTES "Move's dry path"), so
  every pad keeps Attack at its minimum, and a Set with other Attacks
  needs a dry pad at each.

### Test sounds

`tools/fxlab/make_test_wavs.py` writes them to `build/test_wavs/`, mono,
44.1 kHz, 16-bit. Each starts with a step or click at frame 0, to line a
recording of Move's output up with a render of plugin.c.

| File | What it is | What it measures |
|---|---|---|
| sine_441 | 441 Hz (100 frames a cycle), -6 dBFS, 2 s, cosine phase | pitch over time (Pitch Env, FM, Stretch); Ring Mod's sidebands; Sub Osc's added tone; Punch's gain curve on a steady level |
| click_train | one-frame clicks every 100 ms, 2 s | Loop's Offset and Length; Stretch's grain size and window; 8-Bit's rate (a click held one rate period) and its Decay's low-pass |
| silence_click | one click, then 2 s of silence | Sub Osc and Noise alone: envelope, level, Noise Color; whether Noise follows the sound's level |
| noise_white | white noise, -12 dBFS RMS, 2 s, seeded | 8-Bit Decay's low-pass closing and its bit-reduction floor |
| position_ramp | a straight ramp, -16000 to +16000 over 2 s | the frame read at each moment: Stretch's grains, Loop's wrap, the read rate under Pitch Env and FM (Move's dry path passes it unbent) |
| sweep | 20 Hz-20 kHz log sweep, -6 dBFS, 4 s | 8-Bit's aliasing and filtering; any filtering in Move's neutral path |
| sine_441_quiet | sine_441 at -30 dBFS | whether an effect depends on the input level, as a compressor would |
| drum_synth | a kick-like hit: a sine falling from 150 to 50 Hz under a 250 ms decay, plus a 3 ms noise burst, -8 dBFS peak, 1 s | a realistic transient in every acceptance Set, on the bands metric (in place of a real kick or snare checked by ear); -8 dBFS leaves room for Punch's x2 makeup under the capture's soft-clip knee |

### What to record

Baseline for every take: Attack at its minimum, Hold Inf, the filter
Low-Pass 24 fully open, Transpose 0. Note the value Move shows for each
setting (its knob steps rarely land on round numbers; `split` reads the
exact values from `Song.abl` anyway). Loop, and any pad whose sound would
run into the next, needs a finite Hold (e.g. 2 s): the pads of a Drum Rack
don't cut each other off, and the split needs silence between them.
Include one dry pad (Stretch 1.00, sine_441) in every Set as its level
reference.

| Effect | Files | Settings |
|---|---|---|
| Pitch Env | sine_441, position_ramp | Set 32 (NOTES "Pitch Env") |
| FM | sine_441, position_ramp | Amount 25 %, 100 %; Freq 10 Hz, 1 kHz; global Decay 100 ms and 60 s (with Hold short), for the modulation's decay |
| Ring Mod | sine_441 | Amount 50 %, 100 %; Freq 5 Hz, 1 kHz; global Decay as for FM |
| Sub Osc | silence_click, sine_441 | Amount 100 %; Freq 30, 60, 120 Hz; Attack 0 and 100 ms, Hold short, Decay 100 ms; and Hold Inf with Decay 100 ms, for whether Hold applies |
| Noise | silence_click, sine_441 | Amount 100 %; Color 180 Hz, 1 kHz, 15 kHz; envelope as for Sub Osc |
| 8-Bit | click_train, noise_white, sweep | Rate 1 kHz, 14.1 kHz; Decay Off, 100 ms, 1 s |
| Stretch | click_train, position_ramp, sine_441 | Factor 2, 20; Grain 5 ms, 100 ms, 300 ms |
| Loop | click_train, position_ramp | Offset 0, 25 %; Length 10 ms, 300 ms, 500 ms |
| Transpose +12 | sine_441 | Ring Mod 1 kHz, Sub Osc 60 Hz, Noise 1 kHz, FM 100 Hz, Stretch 2 / 100 ms, Loop 100 ms: which settings follow the pitch; and no effect with Hold 200 ms, Decay 200 ms: whether the envelope follows it |

### Open

- **Preview level:** LiveChopper's chop mode plays at unity, 1.45 dB above
  Move's dry level (0.8465, NOTES "Move's dry path"), so a chop sounds
  louder before export than after. `check` compares each take at its own
  level, so it doesn't fail on it. To decide: match Move or keep unity.
- **Preview against the render:** on Punch they differ by up to 0.28 dB,
  untraced. Both knob models step the same grid, so the knob values aren't
  an obvious cause; log the values the preview actually used and render
  those.
- **Where the full-scale clip sits:** Move clips after the effect and
  before its filter, LiveChopper after its filter (NOTES "Punch",
  ceiling). It matters only when the filter rings.
- **Move's dry path:** its 4-frame attack ramp, ~9.5 ms end fade and
  Nyquist ring (NOTES "Move's dry path") are candidates for chop mode.
  The metrics don't need them. Pitch Env's A/B (2026-11-13) heard a
  subtle onset difference on every pair, the dry one included, and
  accepted it; the first 10 ms differ by 0.3-0.6 dB.
- **Preview read position:** in Pitch Env's preview the position_ramp
  hits read 0.5-0.8 ms (rms) off both the render and Move, while the
  render matches Move to 0.02 ms. It passes (worst 1.64 ms against 2),
  but it's in LiveChopper's playback on the Move or the take's alignment;
  untraced.
- **FM read drift:** with deep modulation and a slow Decay our read ends a
  few frames from Move's (Set 36 pad 11: 3.15 frames, 0.07 ms; Set 34
  pad 9: one quiet 44 Hz band window at 4.45 dB against 3, accepted
  2026-11-14). Under 0.2 % of the modulation's net shift; not the depth
  alone. Untraced.
- **Short Attack (Set 35 pad 15):** Attack 0.1 ms sits up to 0.8 dB under
  Attack 1 ms for the first ~60 frames; it passes (bands 0.42 dB).
- **Fast turns:** Move skips 2-3 values on a fast turn (NOTES, screen
  session 1). LiveChopper reads the encoder's delta, so it may already do
  the same; unchecked.

## Other ideas (not committed to)

- Snap chops to the set's tempo.
- Use the right-hand 16 pads, which do nothing today.
- Per-pad sound settings before export. SPEC currently leaves these to the
  drum rack on purpose.

## Maintenance

- A weekly scheduled CI run, so a new Schwung release is tested even while
  this repo is idle.
