# LiveChopper plan

Work that isn't built yet. [SPEC.md](SPEC.md) describes what the module does
today; when something here is built, its decisions move into SPEC.md and it
comes off this list. What was measured along the way goes to
[NOTES.md](NOTES.md).

## Road to v1.0.0

Agreed 2026-11-15, after v0.9.0: finish matching the effects, polish and
fix bugs, then release v1.0.0. Point releases in between are fine.

1. **Match the remaining effects** (below, "Status"): Stretch and Loop
   (8-Bit done 2026-11-17, following Transpose 2026-11-16).
2. **Decide what 1.0 needs of Stretch and Loop** (next): matched
   to Move, or shipped as LiveChopper's own stand-ins, documented in
   SPEC as such. Neither has been measured on Move, and they differ in
   cost (Loop is a read position, which position_ramp shows; Stretch's
   grain algorithm is unknown), so each is decided on its own:
   - 2a. One scouting Set for both (Set 52,
     `tools/fxlab/sets/set52_stretch_loop_scout.json`), as Sets 40-42
     served Sub Osc and Noise: what each does, priced before committing.
     Done 2026-11-17 (NOTES "Stretch and Loop on Move"): both are simple
     and deterministic, and a numpy model of each fits Move, so 2d is
     "match" too.
   - 2b. Make the position metric work under a non-flat envelope,
     since Loop's pads need a finite Hold; re-score the position refs.
     Done 2026-11-17 (NOTES "The position metric under an envelope").
   - 2c. Loop: the per-effect workflow to "matched" (PLAN "Method"). If
     its wrap turns out to be Move's end fade, model that with it (step 3).
     Built 2026-11-17 (not Move's end fade: a 9 ms linear crossfade);
     Set 52's Loop pads pass `check` (position 0.01-0.02 ms rms).
     Acceptance Set 53 drawn with `accept-set Loop` (its own draw: every
     Attack 1 ms, a finite Hold of 0.3-2.5 s or a gate on pads 7 and 13,
     4 pads transposed within 12 st, on position_ramp, sine_441,
     click_train and drum_synth), seed 1123,
     `tools/fxlab/sets/set53_loop_accept.json`. Next: record it, `check`,
     refs, then preview, `device-check`, A/B. Open: how Move's Loop treats a Drum
     Preset pad's region (Voice_PlaybackStart/Length): Set 52 measured
     whole files, as the Slices export makes; the region may count as the
     sample (as built) or the loop may read on past it.
   - 2d. Stretch: from Set 52, match it if its grains are deterministic and
     fit a model; otherwise keep the stand-in, document it in SPEC as
     LiveChopper's own, and A/B it for information only.
3. **Settle the "Open" items that change the sound:** the preview level
   (unity, 1.45 dB above Move), Move's dry onset (its 4-frame attack ramp
   and end fade, the onset heard in Pitch Env's A/B), and fast turns. The
   small untraced offsets that pass can stay open past 1.0.
4. **Polish and bug-fix on the device:** a full pass of the workflow
   (chop, fine-tune, export, then the exported preset on Move against
   chop mode), help.json, the screen reader's announcements, a knob
   reversed by one click (Punch's preview, 2026-11-16: 83 % reached from
   84 % with one click down may have landed on 1080, not the 1090
   `stepKnob` predicts; a two-hit take, straight up and up-then-down,
   settles it), and anything found in use; the weekly CI run
   ("Maintenance").
5. **Release v1.0.0**, its notes summing up the module as a whole.

## Match the drum sampler effects to Move

Steps 1-3 are done: one knob model for every knob that mirrors Move (SPEC
"Knob model"), and the Effect knob with Move's nine effects, each with a
stand-in in chop mode (SPEC "Effect"). What they were built from is in
NOTES "Move's Drum Sampler, measured".

Step 4, still open: tune each stand-in to Move. Apart from Punch they are
LiveChopper's own designs, not Move's algorithms.

### Status

- Done: Punch (2026-11-12). Acceptance Set 31, seed 1112, references in
  `tests/move_refs/punch/`; measurements and model in NOTES "Punch".
  Preview checks and listening A/B passed 2026-11-16 (no difference
  heard on any of 12 pairs).
- Done: Pitch Env (2026-11-13). Fitted on Set 32, acceptance Set 33,
  seed 1113, references in `tests/move_refs/pitch_env/`; preview checks,
  `device-check` and listening A/B passed (2026-11-13: a subtle onset
  difference heard on 7 of 10 pairs, the dry pair too, Move named at
  chance, all accepted). NOTES "Pitch Env".
- Done: FM (2026-11-15). Fitted on Sets 34 and 36, acceptance Set 37,
  seed 1115 (`tools/fxlab/sets/set37_fm_accept.json`), references in
  `tests/move_refs/fm/`; preview checks, `device-check` and listening
  A/B passed (2026-11-15: no difference heard on any of 16 pairs).
  NOTES "FM".
- Done: the volume envelope's Decay and Gate release (2026-11-14, Set 35,
  NOTES "Volume envelope"): -84 dB over the Decay, a straight line in dB.
  References in `tests/move_refs/envelope/`.
- Done: Ring Mod (2026-11-15). Fitted on Set 38, acceptance Set 39,
  seed 1116 (`tools/fxlab/sets/set39_ring_accept.json`), references in
  `tests/move_refs/ring_mod/`; preview checks, `device-check` and
  listening A/B passed (2026-11-15: no difference heard on any of 16
  pairs). NOTES "Ring Mod".
- Done: Sub Osc and Noise (2026-11-16). Fitted on Sets 40-42
  (NOTES "Sub Osc and Noise"); acceptance Sets drawn: Set 43, Sub Osc,
  seed 1117 (`tools/fxlab/sets/set43_subosc_accept.json`), and Set 44,
  Noise, seed 1118 (`set44_noise_accept.json`), Trigger pads at Hold Inf.
  Sub Osc accepted on Set 43, 16 of 16, refs in `tests/move_refs/sub_osc/`
  (the click pads have no bands metric: checked by hand, after a low-pass
  that drops the dry click's Nyquist ring, gain within 0.5 %, overdamped
  pads included). Noise not accepted on Set 44: its Amount law was up to
  5.7 dB loud under 25 %, which bands can't see; refitted on Set 45, and
  check has a noise metric. Noise accepted on a fresh Set 46, seed 1119
  (`set46_noise_accept.json`), 16 of 16 with pad 3's bands waived (`refs
  --waive`: drum and noise equally loud near 160 Hz, so one take's bands
  swing past the limit; plugin.c against itself over 10 seeds up to
  1.67/5.44), refs in `tests/move_refs/noise/`. Preview checks,
  `device-check` and listening A/B passed (2026-11-16: no difference
  heard on any of 32 pairs, 16 a Set; NOTES "Sub Osc and Noise"). Open:
  Noise under a finite Hold, at other Attacks and on Gate pads, its
  follower's exact shape, and a Gate Sub Osc pad's jump at the note-off.
- Done: 8-Bit (2026-11-17). Fitted on Sets 49 and 50 (NOTES "8-Bit"): a
  hold at the Rate (unrounded) x the pitch ratio, read between frames,
  8 bits of A-law truncated toward zero, a two-pole low-pass (k = 2.18)
  at 20 kHz that a Decay closes towards 300 Hz. An 8-Bit pad's bands are
  averaged over 16 windows (`crush_pad`), and click_train left its
  acceptance sounds (Move's hold period drifts, untraced). Set 50 (seed
  1121) not accepted, a fit Set now. Accepted on Set 51, seed 1122
  (`tools/fxlab/sets/set51_8bit_accept.json`), 12 of 16 with the bands
  of pads 2, 12, 16 (sweeps' sub-140 Hz beats under the closed low-pass)
  and 8 (noise, one cell 3.32) waived on the evidence in NOTES; refs in
  `tests/move_refs/8_bit/`. Preview checks (16 of 16 against the render;
  against Move the acceptance's result), `device-check` (Sets 49-51,
  48 pads, worst 1 LSB) and listening A/B passed (2026-11-17: no
  difference heard on any of 16 pairs, the 4 waived ones included).
  Open: the hold's drift.
- Then Stretch, Loop. Sets are written with `fxlab.py make-set` from a
  spec in `tools/fxlab/sets/`.
- Following Transpose: fitted on Set 47 (2026-11-16, NOTES "Following
  Transpose"): Attack, Hold and Decay take their time / pitch ratio
  (Detune included), Gate's release doesn't; FM, Ring Mod and Sub Osc's
  Freq and Noise's Color follow the pitch, the effects' decays don't, and
  FM's swing isn't scaled by it. Pitch Env's Decay and Punch's times
  don't follow (Sets 31, 32). `check`: Set 47 15 of 16 (pad 6 has
  Envelope Follows Pitch off, which LiveChopper has no setting for), Sets
  31 and 32 pass whole. Accepted on Set 48 (2026-11-16, seed 1120,
  `fxlab.py accept-set Transpose`, `tools/fxlab/sets/set48_transpose_accept.json`):
  13 of 16, pads 3 and 9's position and pad 15's bands waived (NOTES
  "Following Transpose"; the position waivers dropped 2026-11-17, when
  the metric learned to fit the level, and both pass), refs in `tests/move_refs/transpose/`. Done
  2026-11-16: preview checks (16 of 16 against the render at the values
  played; against Move the 3 waived pads and pad 4, held 0.345 s by hand
  against the clip's 0.40 s), `device-check` (Sets 47 and 48, 38 pads bit
  for bit) and listening A/B (no difference heard on any of 16 pairs).
  8-Bit's rate follows the pitch, its Decay doesn't (Set 49); Stretch
  and Loop under Transpose go in their own Sets.

### What Live's manual says

Live's Drum Sampler is the same device as Move's, and its manual the only
description of each effect, against LiveChopper's stand-ins:

| Effect | Live's manual | Stand-in today |
|---|---|---|
| Stretch | "changes the sample's length without altering its pitch"; Factor "a multiple of the original playback speed", Grain Size in ms | two Hann grains half a grain apart (NOTES "Stretch and Loop stand-ins") |
| Loop | "repeats a portion of the sample"; Offset "the loop start point relative to the sample start", Length in ms | fitted to Move (Set 52): plays from the start, wraps at Offset + Length with a 9 ms crossfade |
| Pitch Env | -100 to 100 % | matched to Move (48 semitones at 100 %) |
| Punch | ducking with a fixed attack, emphasising the transient; Release is how long the gain reduction takes to return | matched to Move |
| 8-Bit | "a combination of filtering, bit reduction, and sample rate reduction"; Decay is the low-pass's decay | fitted to Move (Set 49): hold, A-law 8 bits, a two-pole low-pass a Decay closes to 300 Hz |
| FM, Ring Mod | the modulation decays with the global Decay ("with short decay times, the modulation applies only to the transient") | constant modulation |
| Sub Osc, Noise | their envelope is "the device's attack and decay settings" (Hold isn't mentioned: they may decay even at Hold Inf) | both go through the voice's whole envelope, Hold included; Noise also follows the sound's level, which Move may not |
| Stretch, Loop, FM, Ring Mod, Sub Osc, Noise | time and frequency settings follow the global pitch and the note | FM, Ring Mod, Sub Osc and Noise's frequencies follow, as on Move (Set 47); of Stretch and Loop only Loop Length follows |

Live's Drum Sampler reference also has "Envelope Follows Pitch", a
context-menu option scaling the amplitude envelope with the pitch. Move
has no knob for it, but its presets store it as
`Voice_PitchToEnvelopeModulation`: true on every pad of Set 28 (Move's
default), and LiveChopper's export writes true too (`src/drum_rack.mjs`).
LiveChopper's envelope follows the pitch as Move's does with it on (Set
47; Gate's release doesn't). Punch's times don't follow Transpose (Set
31), nor does Pitch Env's Decay (Set 32), nor the other effects' decays
(Set 47).

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
   first), about 3 s apart, each knob spun to its bottom end before
   every value and then dialled up by whole clicks to the readout (no
   Shift; one touch of the top end puts later clicks 2 units off, as in
   Ring Mod's preview), then press Shift+Capture: Skipback saves the
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
  drum_synth, after tuning, from a seed recorded under "Status". It draws
  only positions the preview can be dialled to from the readout: on the
  grid a knob sits on once spun to its bottom end and then clicked up (no
  Shift), and whose readout no other grid position shows (`dialPositions` in `tools/fxlab/knob_readout.mjs`, checked by
  `tests/knobs_test.mjs`). A Set
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
| Ring Mod | sine_441, position_ramp | Set 38 (NOTES "Ring Mod") |
| Sub Osc | silence_click, sine_441 | Amount 100 %; Freq 30, 60, 120 Hz; Attack 0 and 100 ms, Hold short, Decay 100 ms; and Hold Inf with Decay 100 ms, for whether Hold applies |
| Noise | silence_click, sine_441 | Amount 100 %; Color 180 Hz, 1 kHz, 15 kHz; envelope as for Sub Osc |
| 8-Bit | Set 49 (NOTES "8-Bit"); acceptance: sweep, noise_white, sine_441_quiet, position_ramp (not click_train: Move's hold drifts) | Set 49 |
| Stretch | click_train, position_ramp, sine_441 | Factor 2, 20; Grain 5 ms, 100 ms, 300 ms |
| Loop | Set 52 (NOTES "Stretch and Loop on Move"); acceptance: position_ramp, sine_441, click_train, a finite Hold or a gate | Set 52 |
| Transpose +12 | sine_441, position_ramp | 8-Bit 1 kHz, Stretch 2 / 100 ms, Loop 100 ms: whether they follow the pitch (the envelope and the other effects: Set 47) |

### Open

- **`check --ours-take` on a Gate pad:** it compares only while both
  pieces sound, so a preview let go early passes (Set 48 pad 4 held
  0.119 s against 0.40 s, bands 0.04). Compare to the longer piece's end.

- **Preview level:** LiveChopper's chop mode plays at unity, 1.45 dB above
  Move's dry level (0.8465, NOTES "Move's dry path"), so a chop sounds
  louder before export than after. `check` compares each take at its own
  level, so it doesn't fail on it. Decided 2026-11-17: match Move, in two
  stages. First the constant 0.8465 (Move's level at the minimum Attack
  under Hold Inf, the default). Then the level's dependence on Attack
  (0.9311 at 1 ms; points between to be measured) and its climb over a
  finite Hold ("The level under a finite Hold"), with Move's dry onset.
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
- **The level under a finite Hold:** Move's level climbs linearly over
  the Hold, from the Attack's dry level (0.8465 at 0.1 ms, 0.9311 at
  1 ms) to about 0.933 (NOTES "Volume envelope"); with Hold Inf it stays
  put. LiveChopper's envelope is flat. At Attack 0.1 ms that's 0.85 dB by
  the Hold's end: Set 38 pad 15 fails bands on it, Set 35 pad 15 passed.
  Bears on "Preview level": Move's level isn't one number. Acceptance
  Sets keep Hold Inf.
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
