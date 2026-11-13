# LiveChopper plan

Work that isn't built yet. [SPEC.md](SPEC.md) describes what the module does
today; when something here is built, its decisions move into SPEC.md and it
comes off this list.

## Remaining drum sampler effects

The knobs already mirror Move's Drum Sampler (SPEC "Knob pages"), but of its
built-in effects only 8-Bit is done (SPEC "Crush"). Every exported preset
already writes the fields for all of them (`src/drum_rack.mjs`), so the
export side is mostly choosing the type and filling in two values.

| Effect | `Effect_Type` | Setting 1 (Knob 7): range | Setting 2 (Knob 8): range | Move's defaults |
|---|---|---|---|---|
| 8-Bit (done) | "8-bit" | EightBitResamplingRate: 1000-30000 Hz | EightBitFilterDecay: 0.01-5 | 14080, 5.0 |
| Stretch | "Stretch" | StretchFactor: 1-20 | StretchGrainSize: 0.005-0.3 | 1.0, 0.1 |
| Punch | "Punch" | PunchAmount: 0-1 | PunchTime: 0.06-1 | 0.0, 0.12016 |
| Pitch Env | "Pitch Env" | PitchEnvelopeAmount: -1 to +1 | PitchEnvelopeDecay: 0.005-2 | 0.0, 0.3 |
| FM | "FM" | FmAmount: 0-1 | FmFrequency: 10-4500 Hz | 0.0, 1000 |
| Ring Mod | "Ring Mod" | RingModAmount: 0-1 | RingModFrequency: 1-5000 Hz | 0.0, 1000 |
| Sub Osc | "Sub Osc" | SubOscAmount: 0-1 | SubOscFrequency: 30-120 Hz | 0.0, 60 |
| Noise | "Noise" | NoiseAmount: 0-1 | NoiseFrequency: 180-15000 Hz | 0.0, 10000 |
| Loop | "Loop" | LoopLength: 0.01-0.5 | LoopOffset: 0-1 | 0.3, 0.0 |

Field names drop the `Effect_` prefix. Times are presumably seconds; units
are not stored in the set file. Sources:

- `Effect_Type` strings: real Move presets (Schwung's and the waveform
  editor's test data), and a Move set built to test this (Set 18, a 909 Kit,
  read 2026-11-09), which confirmed "Noise" and "Loop".
- Ranges: Set 18 has two pads per effect, one with each setting turned
  fully down and one fully up. Set 19 (a Viral Kit, read 2026-11-09) does
  the same for Noise and for 8-Bit's Filter Decay. Where a fully-down or
  fully-up value equals the default (Noise Amount 0, 8-Bit Filter Decay 5),
  the default sits at that end of the range.
- Defaults: the 909 Kit preset's values (`presetValue` in the set), which
  match Move's set fixture in Schwung.

Move's manual (Drum Sampler, Main Bank) confirms that each effect's two
settings are on Knobs 7 and 8, and lists the effects in this order:
Stretch, Loop, Pitch Env, Punch, 8-Bit, FM, Ring Mod, Sub Osc, Noise. It
has no Off. It doesn't name the two settings of each effect; screen
session 3 (below) shows the knob order matches the table above for every
effect except Loop: Offset is on Knob 7 and Length on Knob 8.

### Proposed design

Extends SPEC "Crush"; the decision there becomes "Effect".

- Main Knob 6 steps through the nine effects in Move's order. There is no
  Off, as on Move (decided 2026-11-09): the default is Stretch at factor
  1.0, which is what LiveChopper's Off exports today, so existing presets
  don't change. SPEC's "Off / 8-Bit" readout and help text go.
- Main Knob 7 is the selected effect's first setting, Main Knob 8 its
  second. Knob 8 is unused today, so this also gives 8-Bit its Filter Decay,
  as on Move.
- One effect at a time, global for every pad, like the rest of the sound
  settings. Each effect keeps its own two values while you switch between
  them, as the filter keeps Resonance and Peak Gain apart.
- Readouts, steps and Shift fine steps copy Move's, as for the filter.
  Knob curves and step sizes: see "Knob curves" below.
- Export: `Effect_Type` plus that effect's two fields; the other effects'
  fields stay at their defaults.
- Chop mode plays a stand-in for each effect, not an emulation, in
  drumCell's order: sample -> effect -> filter -> envelope.
- Resume keeps the selected effect and all values; any change counts as
  unexported work.
- Readout labels are short, to fit the bottom line (decided 2026-11-10);
  the screen reader says Move's full names:

  | Effect | Knob 7 | Knob 8 |
  |---|---|---|
  | Stretch | Factor | Grain |
  | Loop | Offset | Loop Len |
  | Pitch Env | Amount | Decay |
  | Punch | Amount | Release |
  | 8-Bit | Rate | Decay |
  | FM | Amount | Freq |
  | Ring Mod | Amount | Freq |
  | Sub Osc | Amount | Freq |
  | Noise | Amount | Color |

- Stand-ins (decided 2026-11-10, "okay for now"), each a small per-voice
  block before the filter:
  - Punch: a gain boost of up to +12 dB at the voice's start, dying away
    over Release.
  - Pitch Env: a pitch offset of up to +-24 semitones (100%), decaying over
    Decay.
  - Sub Osc: a sine at Frequency, mixed in by Amount.
  - Ring Mod: the sound times a sine at Frequency, blended in by Amount.
  - FM: a sine at Frequency wobbles the playback rate, up to +-1 octave at
    100%.
  - Noise: noise low-passed at Color, following the sound's level, mixed in
    by Amount.
  - 8-Bit: today's, plus its Decay.
  - Stretch and Loop: exported, played dry until step 3.

### Build order

1. Done (2026-11-10, see SPEC "Knob model"): one knob model for every
   knob that mirrors Move (`src/knobs.mjs`, checked against the device by
   `tests/knobs_test.mjs`), on Attack, Hold, Decay, 8-Bit Rate, Frequency,
   Resonance and Peak Gain; Move's formats everywhere, "Inf" for the top
   Hold; Shift on Knob 5 is Length while held (no Shift+tap, no fine steps
   on Decay or Length). Readout labels stay LiveChopper's short ones
   ("Freq", "Peak Gain") to fit the bottom line.
2. Done (2026-11-10, see SPEC "Effect"): the Effect knob (nine effects,
   no Off) with Knobs 7/8 on the knob model, 8-Bit's Decay on Knob 8, and
   stand-ins for Punch, Pitch Env (100% = 24 semitones for now), Sub Osc,
   Ring Mod, FM, Noise and 8-Bit's Decay. The Loop Offset default is fixed.
   Stretch and Loop export, and play dry in chop mode. tests/knobs_test.mjs
   checks every effect setting against Move's session 3 readouts.
3. Done (2026-11-11, see SPEC "Effect"; design below): stand-ins for
   Stretch and Loop, which change how the slice is read, so they interact
   with the playhead a chop reads and with slice ends.
4. Refine every preview against Move (below): the stand-ins so far are
   LiveChopper's own designs, not Move's algorithms.

### Step 3: Stretch and Loop

Live's manual (Drum Sampler, 31.4.2 Playback Effects; the same device as
Move's) is the only description: Stretch "changes the sample's length
without altering its pitch", Factor being "a multiple of the original
playback speed" and Grain Size the grain in ms; Loop "repeats a portion of
the sample", Loop Offset setting "the loop start point relative to the
sample start" and Loop Length its duration in ms.

- Both run inside one voice path shared by the playing voice and the choke
  tail (read, 8-Bit, effect, filter, advance), and each voice knows its
  slice's start as well as its end, kept up to date when a chop, delete or
  marker nudge changes the slice under it.
- Stretch: at Factor 1.00 playback is exactly today's dry path (the
  default, so nothing changes for existing chops). Otherwise the playhead
  moves at 1/Factor of the normal speed, so a slice lasts about Factor times
  as long, and the sound comes from two grains of Grain Size, half a grain
  apart, each under a Hann window (the two always sum to 1). A grain starts
  at the playhead and reads at the normal speed, so the pitch is kept, and
  restarts at the playhead when it ends, or early enough to end inside the
  slice (otherwise the last grains of a long stretch run into silence); the
  voice ends when the playhead reaches the slice end, as today. The
  envelope runs in real time, so a short Decay cuts a long stretch. Plain
  grains drift the pitch a little where the grain is short (5 ms grains on a
  441 Hz tone at Factor 20 read 423 Hz), lo-fi as Live's manual describes
  Move's.
- Loop: the loop starts Offset of the way through the slice and lasts Loop
  Length (in the sample's own time, so Transpose shortens it), clamped to
  the slice's end, and at least 10 ms or the whole slice. Playback starts at
  the Offset, as on Move, and repeats the loop until the envelope ends: Hold and Decay in Trigger mode (with Hold at Inf, until
  another pad cuts it), release and Decay in Gate mode. The level dips for
  1.5 ms either side of each wrap, against clicks (a crossfade would need
  audio from before the loop, which a loop at the very start doesn't
  have). Turning the knobs moves the loop live; a playhead left behind the
  new loop plays on into it.
- Export is unchanged: both already write Move's fields.
- Heard on the Move (2026-11-11): neither sounds like Move's own, which is
  fine for stand-ins; step 4 tunes them.
- Checked by ear on the Move (2026-11-11): Factor 2 plays twice as long,
  and Loop starts at its Offset (LiveChopper first played from the slice
  start into the loop, and was changed to match).

### Step 4: refine the previews against Move

What Live's manual says about each effect, against LiveChopper's stand-ins:

| Effect | Live's manual | Stand-in today |
|---|---|---|
| Punch | ducking with a fixed attack, emphasising the transient; Release is how long the gain reduction takes to return | matched to Move (2026-11-12, see "Punch" below) |
| FM, Ring Mod | the modulation decays with the global Decay ("with short decay times, the modulation applies only to the transient") | constant modulation |
| Sub Osc, Noise | their envelope is "the device's attack and decay settings" (Hold isn't mentioned: they may decay even at Hold Inf) | both go through the voice's whole envelope, Hold included; Noise also follows the sound's level, which Move may not |
| Stretch, Loop, FM, Ring Mod, Sub Osc, Noise | time and frequency settings follow the global pitch and the note | fixed (only Loop Length follows Transpose) |
| 8-Bit | "a combination of filtering, bit reduction, and sample rate reduction"; Decay is the low-pass's decay | sample-and-hold, 8 bits, a low-pass closing to 200 Hz |
| Pitch Env | -100 to 100 % | +-24 semitones at 100 %, a guess |

Live's Drum Sampler reference also has "Envelope Follows Pitch", a
context-menu option scaling the amplitude envelope with the pitch. Move
has no knob for it, but its presets store it as
`Voice_PitchToEnvelopeModulation`: true on every pad of Set 28 (Move's
default), and LiveChopper's export writes true too (`src/drum_rack.mjs`).
LiveChopper's envelope runs in output time, so it doesn't follow pitch;
the Transpose +12 takes show what Move's does.

Method (copies of Move's manual and of Live's Drum Sampler reference are
in `.claude/ref/`, local only; the analysis runs with
`build/.venv/bin/python`, set up by `scripts/setup_analysis_env.sh`:
numpy, scipy and matplotlib, pinned in `scripts/requirements-analysis.txt`):

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
   time about a second apart, nothing else playing, then stop. The take
   starts on a bar; each test sound starts with a step or click, so the
   take is split by onsets. Schwung's Global Settings -> Audio must have
   Move->Schwung On (Move's Link on) and Spkr EQ Off, with no Schwung
   Master FX: the take is then rebuilt from Move's per-track Link Audio
   channels, before Move's master chain (Set 28's first two takes, without
   it, went through the Set template's "Punch Glue" compressor, "Analog
   Clip" and Limiter and Move's speaker enhancer: +6 dB at 150 Hz, a dip
   at 500 Hz, the ramp reduced to a blip). The volume knob doesn't matter
   (the same take at two volumes matched).
4. Copy the take and the Set's `Song.abl` to the host, then
   `build/.venv/bin/python scripts/fxlab.py all <take.wav> <Song.abl>
   <outdir>`. It splits the take at onsets (the k-th onset is the k-th pad
   with a sample, by note, so play the pads in order with at least 0.25 s
   of silence between), saves each pad's settings, renders the same sound
   and settings through plugin.c (`scripts/fx_render.c`, built into
   `build/fx_render`), lines the two up and compares: level (5 ms RMS),
   pitch (sine_441), read position (position_ramp, to ~0.2 ms), 1/3-octave
   bands over time (noise_white, sweep) and the sample-exact residual.
   Plots go to `<outdir>/plots/`, numbers to `<outdir>/compare.json`. The
   level reference is fitted from the Set's dry pieces, else Set 28's.
   For Punch, it also renders each pad dry and plots the gain against that
   over time, Move's and ours (sine: a 100-frame window every 10 frames;
   click_train: each click from 100 ms on, since the attack ramp hides the
   one on frame 0), with the deepest cut or boost, when the curve first
   moves 0.5 dB, and how long it takes to come 63 % and 90 % of the way
   back. Move's curve is also saved as `plots/<piece>_gain.txt`. Checked
   on a synthetic take (a known -10 dB duck): depth and recovery times
   come out within a window's width.
5. Read the plots and numbers for what each effect does differently.
6. Tune each stand-in and record the decision here.
7. When it looks right, prove it: `fxlab.py accept-set <effect> --seed
   <n>` draws a held-out acceptance Set, which is recorded and split as
   above, then `fxlab.py check <outdir>`. The effect is done when that
   passes (see "When an effect is done"); `fxlab.py refs <outdir> --seed
   <n>` then saves Move's curves to `tests/move_refs/`, and the seed goes
   here.
8. Then check the preview as the Move plays it. In LiveChopper (a fresh
   session, so the installed `dsp.so` loads), load the test sound and play
   pad 1 once per setting, copying pads of a recorded Set (a dry one
   first), about 3 s apart, then press Shift+Capture: Skipback saves the
   last 30 s (Schwung's default; its settings can lengthen it) to
   `Samples/Schwung/Skipback/<date>/`. The Quantized Sampler
   can't be used here: Schwung arms it only outside its own UI, so inside a
   tool Shift+Sample reaches the tool (`schwung_shim.c`, the sampler's
   `!shadow_display_mode`). Skipback's Shift+Capture is taken by the shim
   everywhere, and a tool's DSP is mixed into the same capture. Then
   `fxlab.py split <skipback.wav> --like <Set outdir>:NN,NN,...
   <preview outdir>`, and two verdicts: `fxlab.py check <preview outdir>`
   (the preview against plugin.c's render: the knobs and the output path)
   and `fxlab.py check <Set outdir> --ours-take <preview outdir>` (Move's
   own effect against the preview as heard on the Move).
   `fxlab.py device-check <outdirs>` covers the rest: plugin.c built for the
   Move computes the host's renders bit for bit.

Move's dry path (Set 28, 2026-11-12: the six sounds at Stretch 1.00,
Attack minimum, Hold Inf, Low-Pass 24 at 22 kHz, pad Volume -12 dB,
Velocity to Volume 0.5, Full Velocity; `.claude/recordings/set28/`, local
only):

- Gain -1.45 dB (0.8465) on every sound, the same in both volumes, and
  flat to +-0.02 dB from 30 Hz to 19.5 kHz. It isn't the pad's -12 dB, so
  each Set's dry take sets the reference level; effects are compared
  relative to it.
- Attack at its minimum (0.10 ms) is a linear ramp over the first 4
  frames (0.25, 0.49, 0.76, 0.99), so a click on frame 0 almost vanishes.
  LiveChopper's Attack 0 starts at full level.
- The end of the sample fades out over its last ~417 frames (9.5 ms),
  S-shaped (gain 0.79 300 frames before the end, 0.41 at 200, 0.10 at
  100). LiveChopper's slices stop dead. Both are candidates for matching
  in chop mode, apart from the effects.
- Low-Pass 24 at 22 kHz is a real filter, not a bypass: a click is
  followed by a ring at Nyquist (+-780 after a 24k click, alternating each
  frame, falling ~2% a frame). Inaudible; LiveChopper bypasses it.
- position_ramp passes cleanly: gain and offset alone fit it to 0.5 LSB
  rms, so each value gives the frame read to ~2 frames. Usable for Loop,
  Pitch Env and FM (not Stretch, whose crossfading grains mix two
  positions; click_train shows its grains).
- `scripts/fxlab.py` on this take (render of plugin.c at the same
  settings): gain 0.8462, residual over the steady part 5.9 LSB (sine),
  2.4 LSB (ramp), pitch 0.00 st, read position 0.18 ms rms, bands 0.00 dB.
  What remains is the attack ramp, the end fade and the Nyquist ring
  above.

### When an effect is done

Decided 2026-11-12: an effect is done when a held-out acceptance Set
passes `fxlab.py check`, which means every pad passes every metric that
applies to it. Listening plays no part. Each metric is a curve over time from
note-on, Move's against ours, from 1 ms (past the attack ramp) to 20 ms
before the sound ends (clear of Move's end fade), with limits from
hearing thresholds:

| Metric | What it compares | rms | max | Applies to |
|---|---|---|---|---|
| gain | gain against the same pad rendered dry, a 100-frame window every 10 frames | 0.5 dB | 1.5 dB | sine_441(_quiet) under Punch, or Ring Mod below 20 Hz |
| pitch | pitch between zero crossings | 5 ct | 15 ct | sine_441(_quiet) dry, under Punch, Pitch Env, or FM below 20 Hz |
| position | the frame read, from position_ramp's value | 1 ms | 2 ms | position_ramp dry, under Loop, Pitch Env, or FM below 20 Hz |
| bands | 1/3-octave levels over time (4096-frame windows, hop 1024), cells within 40 dB of the loudest and above -80 dB full scale; both sides clamped at that floor | 1 dB | 3 dB | every pad: the catch-all |

- **Held out:** `accept-set` draws each setting at a random whole number
  of knob clicks (so Move's curves apply), on the effect's test sounds plus
  drum_synth, after tuning, from a seed recorded here. A Set that fails
  becomes one more fit Set, and the next try uses a new seed.
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
- **Shown so far:** Set 28's dry pads pass every metric with room to spare
  (bands 0.01 dB, pitch 0.85 ct max, position 0.35 ms max), so the dry
  path's leftover differences (attack ramp, end fade, Nyquist ring) don't
  need matching first. Set 29 fails Punch on gain (up to 18 dB) and bands
  on every sine pad.

Order: Punch, FM and Ring Mod's decay, Sub Osc and Noise's envelopes,
following Transpose, Pitch Env's range, 8-Bit, Stretch, Loop.

Test sounds: `scripts/make_test_wavs.py` writes them to `build/test_wavs/`,
mono, 44.1 kHz, 16-bit. Each starts with a step or click at frame 0, to
line a recording of Move's output up with a render of plugin.c.

| File | What it is | What it measures |
|---|---|---|
| sine_441 | 441 Hz (100 frames a cycle), -6 dBFS, 2 s, cosine phase | pitch over time (Pitch Env, FM, Stretch); Ring Mod's sidebands; Sub Osc's added tone; Punch's gain curve on a steady level |
| click_train | one-frame clicks every 100 ms, 2 s | Loop's Offset and Length; Stretch's grain size and window; 8-Bit's rate (a click held one rate period) and its Decay's low-pass |
| silence_click | one click, then 2 s of silence | Sub Osc and Noise alone: envelope, level, Noise Color; whether Noise follows the sound's level |
| noise_white | white noise, -12 dBFS RMS, 2 s, seeded | 8-Bit Decay's low-pass closing and its bit-reduction floor |
| position_ramp | a straight ramp, -16000 to +16000 over 2 s | the frame read at each moment: Stretch's grains, Loop's wrap, the read rate under Pitch Env and FM; usable only if Move's dry path passes it unbent |
| sweep | 20 Hz-20 kHz log sweep, -6 dBFS, 4 s | 8-Bit's aliasing and filtering; any filtering in Move's neutral path |
| sine_441_quiet | sine_441 at -30 dBFS | whether Punch depends on the input level, as a compressor would |
| drum_synth | a kick-like hit: a sine falling from 150 to 50 Hz under a 250 ms decay, plus a 3 ms noise burst, -8 dBFS peak, 1 s | a realistic transient in every acceptance Set, on the bands metric (in place of a real kick or snare checked by ear); -8 dBFS leaves room for Punch's x2 makeup under the capture's soft-clip knee |

Punch Set (planned 2026-11-12, Set 29): one Drum Rack, 15 pads in note
order, the baseline below on each, played about 3 s apart (the sines last
2 s). Live's manual describes Punch as ducking, not the boost the stand-in
plays: it should answer how deep the duck goes per Amount, how long the
fixed attack leaves the transient alone, the release's shape and length
against Release, whether each click of click_train ducks again (a
compressor) or only the note-on, and whether the quiet sine ducks the same.

| Pads | Sound | Punch |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00): the level reference |
| 2-7 | sine_441 | Amount 50 % and 100 %, each at Release 60 ms, 120 ms (default), 1.00 s |
| 8-13 | click_train | the same six |
| 14 | sine_441_quiet | dry |
| 15 | sine_441_quiet | Amount 100 %, Release 120 ms |

Recorded 2026-11-12 (`.claude/recordings/set29/`, local only; Amount
50 % is 0.4969 on Move's knob). Move's Punch is a fixed gain envelope from
note-on, nothing like the stand-in's boost at the start:

- Makeup: the start and everything after the release sit at 1 + Amount³
  of the dry level (1.1227 = +1.00 dB at 0.4969, exact to 4 digits; 2.000
  = +6.02 dB at 100 %). So the transient keeps that level and the body is
  ducked below it.
- Not level-dependent: sine_441_quiet's curve matches sine_441's to 0.1
  dB. Nor retriggered: each click of click_train lands on the sine's curve
  for the same settings.
- Duck attack: the same for every Release. Barely moving at 2 ms, halfway
  down at 14-18 ms, 95 % of the way by ~50 ms, done by ~80 ms.
- Depth (the bottom against the makeup, with Release long enough to get
  there): -6.0 dB at 49.7 %, -16.5 dB at 100 %; absolute 0.565 and 0.300 of
  dry. Two points fit neither linear in Amount nor linear in dB.
- Release: back to the makeup level at about Release after note-on (90 %
  back by ~1.0 R at 1 s, later relative to R at 120 ms and 60 ms, where
  the attack hasn't finished). At 100 % and 1 s the bottom is flat until
  0.6 R and then rises about evenly in dB; at 50 % it starts rising from
  about 0.4 R, so the shape isn't one curve scaled by depth (neither in
  linear gain nor in dB). Perhaps the duck is clamped at a floor at high
  Amounts.
- Ceiling: at 100 % click_train settles at +2.4 dB, not +6, flat from 30
  Hz to 20 kHz: its clicks (-2.6 dBFS dry) come out at 31918 (-0.23
  dBFS). At 50 % (+1 dB) the clicks pass in full. Explained after Set 30
  (see the capture ceiling): Move clips the doubled click at full scale,
  and Schwung's capture soft-clips that to 31918. The track's Saturator
  after the Drum Rack is at Dry/Wet 0, as in Set 28.

Still to measure: depth and attack against Amount (10, 25, 75, 90 %), the
release's shape at more Release values, and where the ceiling sits.

Punch Set 2 (planned 2026-11-12, Set 30): the same baseline and timing as
Set 29, 12 pads. Move's knob doesn't land on 10 %, so it's 9.9 %; Release
can show 252 and 506 ms (the Set file records the exact values anyway).

| Pads | Sound | Settings | For |
|---|---|---|---|
| 1 | sine_441 | dry | the level reference |
| 2-5 | sine_441 | Punch 9.9 %, 25 %, 75 %, 90 %, Release 1.00 s | depth, makeup and the attack against Amount (1 s leaves the bottom flat) |
| 6 | sine_441 | Punch 100 %, 1.00 s | Set 29's pad 7 again: do takes repeat |
| 7-8 | sine_441 | Punch 50 %, 100 %, Release 252 ms | the release's shape |
| 9-10 | sine_441 | Punch 50 %, 100 %, Release 506 ms | the release's shape |
| 11 | sine_441 | no effect (Stretch 1.00), Filter Type Peak, Frequency 434 or 457 Hz, Peak Gain 12 dB | the ceiling without Punch: dry peaks of 13900 boosted ~4x. Held near 31900 with the ring of a gain: a limiter after the Drum Sampler; flat tops: plain clipping, so the ceiling belongs to Punch |
| 12 | click_train | Punch 75 %, 1.00 s | the ceiling again: makeup 1.42 would take the clicks to ~34600 |

`compare` takes only fully dry pads (no effect, the low-pass open, no
gain or transpose) as the level reference, so pad 11 doesn't count.

Recorded 2026-11-12 (`.claude/recordings/set30/`; Amounts 9.86, 25.4,
75.1, 90.1 %, Releases 252 and 506 ms):

- Repeatable: pad 6 matches Set 29's pad 7 to 0.0006 dB rms (0.008 dB
  max). Move's Punch is deterministic.
- Makeup 1 + Amount³ holds at every Amount (+0.01, +0.14, +3.07, +4.76 dB
  predicted; +0.0, +0.1, +3.0, +4.7 measured on the 2 ms start).
- Model: gain = makeup x max(1 - Amount x env(t), 0.15), with env rising
  from 0 to 1 at note-on and falling back to 0 over the Release. The
  bottom against the makeup is 0.902, 0.750, 0.501, 0.248, 0.150, 0.150 at
  9.9, 25, 50, 75, 90, 100 %: 1 - Amount down to the 0.15 clamp. The
  clamp explains Set 29's flat bottom at 100 % and why 90 % ducks deeper
  than 100 % in absolute terms (same clamp, less makeup).
- Release: (1 - g/makeup) / Amount over t/Release is one curve at 1 s for
  every Amount, to 0.02: 0.98 at 0.4 R, 0.95 at 0.5, 0.89 at 0.6, 0.79 at
  0.7, 0.63 at 0.8, 0.40 at 0.9, 0.08 at 1.0, 0 by 1.05 R. At shorter
  Releases its tail runs past R (env 0.14 at R for 506 ms, 0.24 for 252,
  0.41 for 120, 0.54 for 60), as if a fixed smoothing of some ms acts on
  top.
- Attack: env reaches 0.14 at 10 ms and 0.97 at 50 ms at 9.9 %, but 0.38
  at 10 ms at 100 %: faster with more Amount, so not one curve in linear
  gain (nor in dB). The law is still to fit; with six Amounts measured, a
  table interpolated across Amount is a fallback.
- Ceiling: pad 11 (no effect, Peak +12 dB) flattens at exactly 31918
  with a soft knee, so the ceiling isn't Punch's. It is two clips (worked
  out 2026-11-12):
  - Move clips hard at full scale after the effect and before its
    filter. The ring after a clipped click is 1.348 x dry at both 75 % and
    100 % Punch (pad 12, Set 29 pad 13), which is 32767 / 24327: the
    click clipped to full scale, then filtered.
  - Schwung's capture then soft-clips above 29204, and maps full scale to
    exactly 29204 + 3563 tanh(1) = 31918 (see "When an effect is done",
    the capture ceiling).

  LiveChopper also clips at full scale, but after its filter, which
  matters only when the filter rings. Neither clip is part of Punch.

Punch is done when, after tuning on Sets 29 and 30, an acceptance Set
from `fxlab.py accept-set Punch --seed <n>` (sine_441, sine_441_quiet,
drum_synth) passes `fxlab.py check`. Done 2026-11-13: Set 31 passed (12
of 12 pads), its curves are `tests/move_refs/punch/`, and the preview as
the Move plays it passed too (below).

Punch, tuned 2026-11-12 (`src/dsp/plugin.c`, `fx_frame`). Fitted by least
squares to all 14 sine pads of Sets 29 and 30 at once, through the same
100-frame window that measures Move (rms 0.061 dB, worst 0.89 dB):

- gain = (1 + Amount³) x exp(S(ln T)), T = max(1 - Amount x (1 - (t/L)^n),
  0.15), S two one-poles of 10.434 ms in series starting at 0 (0 dB) at
  note-on, L = R - 35.65 R^-0.308 ms (R the Release in ms: 10 ms short at
  60 ms, 4 ms at 1 s), n = 3.975 + 0.555 ln R (R in s: 2.4 at 60 ms, 4.0
  at 1 s).
- Smoothing in dB is what makes the attack faster at higher Amounts: a
  deeper target is a bigger step in dB, so it gets further in the same
  time. The fit put the smoothing domain at p = 0.07 when left free
  (0 being dB). Linear smoothing, a smoothed attack only, a soft floor
  or a floor after the smoothing all fitted worse (worst 1.6-7 dB); a
  release stretched to R plus a few ms, unsmoothed, missed Move's
  exponential tail (its envelope falls ~0.64 every 5 ms after R).
- `fxlab.py check` with it: every Punch pad below the capture's soft-clip
  knee passes on Sets 29 and 30 (gain worst 0.86 dB, bands worst 0.60 dB).
  What fails is clipping: Set 29's 100 % click pads (bands 1.36 dB: the
  clicks clip in both, but Move's take was soft-clipped by Schwung's
  capture as well, and our render was not), Set 30's 75 % click pad on
  the limit (0.99 dB), and Set 30's Peak pad.
- Acceptance Set: `fxlab.py accept-set Punch --seed 1112`, drawn
  2026-11-12 after tuning (Set 31), plus two pads at Transpose +12 for
  whether Punch's times follow the pitch, as "Envelope Follows Pitch"
  (`Voice_PitchToEnvelopeModulation`, on in Move's presets) might make
  them. Both repeat Set 30 settings, so a halved time shows directly:

  | Pad | Sound | Settings |
  |---|---|---|
  | 1 | sine_441 | dry (Stretch 1.00) |
  | 2 | sine_441 | Punch Amount 28 %, Release 75.1 ms |
  | 3 | sine_441_quiet | Punch Amount 75 %, Release 60.0 ms |
  | 4 | drum_synth | Punch Amount 83 %, Release 420 ms |
  | 5 | sine_441 | Punch Amount 57 %, Release 750 ms |
  | 6 | sine_441_quiet | Punch Amount 17 %, Release 192 ms |
  | 7 | drum_synth | Punch Amount 83 %, Release 823 ms |
  | 8 | sine_441 | Punch Amount 6.9 %, Release 60.1 ms |
  | 9 | sine_441_quiet | Punch Amount 69 %, Release 941 ms |
  | 10 | sine_441 | a copy of pad 2 |
  | 11 | sine_441 | Transpose 12 st, Punch Amount 100 %, Release 252 ms (Set 30 pad 8) |
  | 12 | sine_441 | Transpose 12 st, Punch Amount 50 %, Release 506 ms (Set 30 pad 10) |

  Recorded 2026-11-13 with two departures: pad 5's Release is 751 ms
  (750 isn't a step on Move), and every pad's Attack is 1.0 ms, not the
  minimum (the render reads both from the Set, so the comparison holds).
  `fxlab.py check`: 12 of 12 pass, gain worst 0.97 dB (pad 11), bands
  worst 1.04 dB (pad 4, drum_synth), pitch under 1 cent. Pads 11 and 12
  pass with Punch's times unchanged by Transpose, so they don't follow
  the pitch. `fxlab.py refs .claude/recordings/set31/punch --seed 1112`
  saved them as `tests/move_refs/punch/`, which `test.sh` checks.
- Preview on the Move (2026-11-13, `.claude/recordings/preview1/`, a
  Skipback take of LiveChopper playing sine_441 at Set 30 pads 1, 8, 10
  and 2): against plugin.c's render, 4 of 4 pass (gain worst 0.28 dB,
  bands 0.06 dB, pitch 0); Move's own Set 30 pads against it, 4 of 4
  pass (gain worst 0.47 dB, bands 0.26 dB). The preview plays at unity,
  1.45 dB above Move's dry level (0.8465); `check` compares each take at
  its own level, so this isn't part of the verdict.
- Device: `fxlab.py device-check` renders the pads of Sets 28-30 on the
  Move (plugin.c built with build.sh's flags, the Move's libm) and
  compares them with the host's: all 56 renders identical, bit for bit
  (2026-11-12). What `check` measures on the host is what the Move plays.

What to record. Baseline for every take: Attack at its minimum, Hold Inf,
the filter Low-Pass 24 fully open, Transpose 0. Note the value Move shows
for each setting (its knob steps rarely land on round numbers). Loop, and
any pad whose sound would run into the next, needs a finite Hold (e.g. 2
s): the pads of a Drum Rack don't cut each other off, and the split needs
silence between them. Include one dry pad (Stretch 1.00, sine_441) in
every Set as its level reference.

| Effect | Files | Settings |
|---|---|---|
| none (Stretch 1.00) | all six | the dry path, once each: the reference for gain, filtering and alignment |
| Punch | sine_441, click_train; sine_441_quiet | Amount 50 %, 100 %; Release 60 ms, 120 ms, 1 s; the quiet sine dry and at 100 %, 120 ms. See "Punch Set" |
| Pitch Env | sine_441, position_ramp | Amount 100 %, 50 %, -100 %; Decay 300 ms, 2 s |
| FM | sine_441, position_ramp | Amount 25 %, 100 %; Freq 10 Hz, 1 kHz; global Decay 100 ms and 60 s (with Hold short), for the modulation's decay |
| Ring Mod | sine_441 | Amount 50 %, 100 %; Freq 5 Hz, 1 kHz; global Decay as for FM |
| Sub Osc | silence_click, sine_441 | Amount 100 %; Freq 30, 60, 120 Hz; Attack 0 and 100 ms, Hold short, Decay 100 ms; and Hold Inf with Decay 100 ms, for whether Hold applies |
| Noise | silence_click, sine_441 | Amount 100 %; Color 180 Hz, 1 kHz, 15 kHz; envelope as for Sub Osc |
| 8-Bit | click_train, noise_white, sweep | Rate 1 kHz, 14.1 kHz; Decay Off, 100 ms, 1 s |
| Stretch | click_train, position_ramp, sine_441 | Factor 2, 20; Grain 5 ms, 100 ms, 300 ms |
| Loop | click_train, position_ramp | Offset 0, 25 %; Length 10 ms, 300 ms, 500 ms |
| Transpose +12 | sine_441 | Ring Mod 1 kHz, Sub Osc 60 Hz, Noise 1 kHz, FM 100 Hz, Stretch 2 / 100 ms, Loop 100 ms: which settings follow the pitch; and no effect with Hold 200 ms, Decay 200 ms: whether the envelope follows it |

### To settle on the Move first

Answered by Sets 18 and 19: the Noise and Loop type strings, and the
range of every effect setting. Loop Offset's default is 0.0 in both the
909 Kit and Move's set fixture; `src/drum_rack.mjs` wrote 0.02 until step
2 fixed it.

Nothing is open: screen sessions 1-4 (2026-11-09 and 10) answered the
rest. See "Every knob follows Move".

### Knob curves (Set 20)

Set 20 (a Citizen Drop Kit, read 2026-11-09) has one pad per effect with
both settings turned one click from the default: up, except 8-Bit Filter
Decay, whose default is its maximum, so that one went down. Every click
moves the knob by the same amount: 0.7645% of its travel (0.00764526),
about 131 clicks end to end. Each setting maps knob position p (0-1) onto
its range with one of these curves:

| Curve | value = | Settings |
|---|---|---|
| linear | min + (max-min)·p | Punch, Ring Mod, Sub Osc and Noise Amount; Pitch Env Amount |
| log | min·(max/min)^p | 8-Bit Rate, 8-Bit Filter Decay, FM Frequency, Sub Osc Frequency |
| square | min + (max-min)·p² | Stretch Grain Size, Loop Length, Noise Frequency |
| cube | min + (max-min)·p³ | Pitch Env Decay, Punch Time |

Each fits its click to within 1%. Set 21 (a Frantik Kit, read 2026-11-09)
turned the four that didn't fit 10 slow clicks, and settled them:

| Setting | Curve |
|---|---|
| Stretch Factor | square |
| Loop Offset | square |
| FM Amount | cube |
| Ring Mod Frequency | 5th power: min + (max-min)·p⁵ |

Stretch Factor and Loop Offset explain the odd first click: Move keeps
stepping the knob until the value on screen changes. Stretch Factor shows 2
decimals, so 1.00 to 1.01 takes 3 steps; Loop Offset shows a percentage
with 1 decimal. Both match all ten clicks exactly. FM Amount skips too (its
clicks land on knob steps 12 and 28, both exact on the cube curve), but no
simple rounding of its value explains which steps it skips, so its on-screen
format decides that.

Set 21 also measured the envelope and filter frequency, all log curves with
exactly one knob step per click:

| Setting | Move | LiveChopper today (`src/ui.js`) |
|---|---|---|
| Attack | log, 0.0001-20 s | cube, 0-2 s, 100 clicks |
| Hold | log, 0.001-60 s | cube, 0-5 s then Full, 100 clicks |
| Decay | log, 0.001-60 s | cube, 0-10 s, 100 clicks |
| Filter Frequency | log, 30 Hz-22 kHz, x1.0517 a click | 1/24 octave (x1.0293) a click |

The filter's 10-click pad landed on 11 steps, which the display rule can't
explain at those values; probably one extra click. Its single click is
exact. So LiveChopper's filter knob takes about 230 clicks end to end where
Move's takes 131.

This changes existing settings too: LiveChopper's 8-Bit Rate steps are
1/24 octave, but Move's are about 1/27 octave (x1.0263) a click, and the
filter frequency and envelope above differ the same way. The rule for
every Move knob measured (Sets 20-25): 131 equal knob steps across the
range (0.00764526 each, the last one short), a curve per setting, a tenth
of a step with Shift, and steps skipped until the displayed value changes.
Length is the one knob seen that doesn't skip.

### Found along the way: envelope ranges

Set 18's 909 Kit has decays of 12.87 s and 13.92 s, past the Decay knob's
10 s. Set 19 measured the ranges (pads 5 and 6, fully down and fully up)
and Set 21 the curves: see the table under "Knob curves". The export
already writes Hold Full as 60 s, which is Move's maximum, and Move shows
that top Hold as "Inf" (screen session 2): it is LiveChopper's Full, which
should be renamed "Inf". Decay's top is a plain "60.0 s".

## Every knob follows Move

Not just the new effects: every knob that mirrors a Move control follows
Move's range, curve, step size, Shift fine step and on-screen format. Gain
(Filter & Setup Knob 8) is LiveChopper's own, since Move has no Gain knob
there; it keeps Simpler's range and steps.

| Knob | Range | Curve and step | Display |
|---|---|---|---|
| Main 1 Transpose | -48 to +48 st (Set 22, screen) | 1 st a click | "12 st", "-12 st", "0 st" (no +) |
| Shift Main 1 Detune | -50 to +50 ct (Set 22, screen) | 1 ct a click | "5 ct", "-50 ct" (no +) |
| Main 2 Start | sample length | 1 screen column a click | no number: the waveform, the marker and "Start" |
| Shift Main 2 Zoom | stays LiveChopper's own (decided 2026-11-09) | Move has two levels | - |
| Main 3-5 Attack, Hold, Decay | 0.10 ms-20.0 s / 1.00 ms-Inf / 1.00 ms-60.0 s | log, 131 steps, one value a click (Sets 21, 23) | 3 significant figures: "0.10 ms", "10.6 ms", "110 ms", "1.03 s", "20.0 s"; Hold's top is "Inf" |
| Main 5 Length (Move: Shift) | 0-100% of the sample | Move: linear, 0.7645% of the sample a click, no skipping (Set 23). LiveChopper keeps 1 screen column a click (decided 2026-11-09) | "0.0 %"-"9.9 %", then "11 %"-"100 %"; over the waveform, see below |
| Main 6 Effect | nine effects, no Off | one effect a click | "Playback Effect", the effect's name, and a bar for its place in the list |
| Main 7-8 effect settings | measured (Sets 18-19) | measured (Sets 20-21) | see "Screen session 3" |
| Filter 1 Frequency | 30 Hz-22 kHz | log, measured (Set 21) | "Filter Frequency", "30.0 Hz"-"22.0 kHz" |
| Filter 2 Resonance / Peak Gain | 0-0.9 / -12 to +12 dB | both linear (Peak Gain linear in dB), 131 steps (Set 25) | "Filter Resonance" "0.0 %"-"90 %"; "Filter Gain" "-12 dB"-"12 dB" |
| Filter 3 Type, 4 Envelope Mode | four types / Trigger, Gate | one item a click | "Filter Type": Low-Pass 12, Low-Pass 24, High-Pass 24, Peak; "Envelope Mode": Trigger, Gate |

Shift's fine step (the manual mentions it for Attack, Hold, Filter
Frequency and Resonance): on Attack and Hold it is a tenth of a knob step,
skipped until the display changes (Set 23: Attack 0.10 to 0.11 ms took 6
fine steps, Hold 0.80 to 0.81 s took 1; both exact). All 18 effect
settings have the same fine step: Set 24's one Shift click on each landed
on a whole number of tenth-steps (1 to 3 for most, 25 for Stretch Factor,
31 for Loop Offset and 112 for FM Amount, which start where the display is
coarse). Filter Frequency, Resonance and Peak Gain have it too (Set 25). Decay and Length
have none: see below.

Screen session 1 (2026-11-09, `.claude/tools/capture_display.py`; Set 22
holds the raw values):

- Knob readout layout: the name on the top line, a bar under it filled from
  the left in proportion to the value (from the minimum, even for Transpose
  and Detune), the value at bottom left, and the sampler icon at bottom
  right.
- Turning fast skips values: a slow click moves Transpose 1 st, a fast
  turn 2-3. LiveChopper reads the encoder's delta, so this may already
  come through as is; to check.
- Start: the marker is a full-height line with a flag at the top, moving
  one screen column a slow click. Zoomed in, it travels to the screen's
  centre and then the waveform scrolls under it. Only two zoom levels
  showed up (the zoomed view about 2.5x the full one); it's unconfirmed
  whether Zoom has more.
- Mismatches in LiveChopper today: `formatTranspose` and `formatDetune`
  print a "+" ("+12 st") where Move doesn't, and `formatUs` prints "0.1 ms"
  where Move shows Attack's minimum as "0.10 ms".

Screen session 2 (2026-11-09; Set 23 holds the raw values):

- Attack, Hold and Decay each swept end to end, one value a click, every
  value distinct. The ratios per click match the log curves exactly
  (Attack x1.0978, Hold and Decay x1.0878). The knob sits on multiples of
  0.00764526 clamped to 1, so the last click is short: Hold goes 56.1 s
  then Inf.
- Display: 3 significant figures, in ms below 1 s and in s from 1 s.
  LiveChopper's `formatUs` differs ("0.1 ms", "5 ms" and "1.00 s" style,
  and "Full").
- Length: the screen is the waveform with a bracket at each end of the
  played region, "Length" at bottom left and the value at bottom right; no
  bar or icon. Pad 5's one click took Voice_PlaybackLength from 1 to
  0.992355, one knob step of the whole sample, and the sweep shows each
  click moves 0.7645% even where the display repeats ("11 %" twice), so
  Length doesn't skip. LiveChopper's Length instead moves the slice end
  one screen column a click, as Start does, and a chop is often a small part
  of a long recording, where 0.76% of the whole is a big jump (0.92 s on a
  2-minute recording). Decided 2026-11-09: keep the column step. Zoomed out
  it nearly matches Move's (1/124 of the sample against 1/131), and zoomed
  in it gets finer, as Move's own Start knob does. The readout and screen
  follow Move.
- Shift on Knob 5: on Move, holding Shift switches the knob between Decay
  and Length, so neither has a fine step (Set 23's pads 4 and 6 stayed at
  their defaults). LiveChopper toggles with Shift+tap and uses Shift+turn
  as Decay's fine step. Decided 2026-11-09: copy Move. Holding Shift
  switches Knob 5 to Length, so Decay and Length lose their Shift fine
  steps and zoom is Length's only fine adjust, as it already is for Start.
  SPEC's "Shift+tap" bullet and help.json change with it.
- Zoom has only two levels on Move; LiveChopper keeps its own zoom.

Screen session 3 (2026-11-09; Set 24 holds the raw values, pads 2-10 one
Shift click on each setting):

- Knob 6 is titled "Playback Effect". Each click showed the next effect, in
  the manual's order, with the bar moving along the list.
- Each setting's readout uses the usual knob layout. Move's names and
  formats, Knob 7 then Knob 8:

| Effect | Knob 7 | Knob 8 |
|---|---|---|
| Stretch | Stretch Factor: "1.00"-"20.00" (no unit) | Grain Size: "5.00 ms"-"300 ms" |
| Loop | Loop Offset: "0.0 %"-"100 %" | Loop Length: "10.0 ms"-"500 ms" |
| Pitch Env | Pitch Env Amount: "-100 %"-"100 %" | Pitch Env Decay: "5.00 ms"-"2.00 s" |
| Punch | Punch Amount: "0.0 %"-"100 %" | Punch Release: "60.0 ms"-"1.00 s" |
| 8-Bit | 8-Bit Rate: "1.00 kHz"-"30.0 kHz" | 8-Bit Decay: "10.0 ms"-"3.98 s", then "Off" at the top (5.0) |
| FM | FM Amount: "0.0 %"-"100 %" | FM Frequency: "10.0 Hz"-"4.50 kHz" |
| Ring Mod | Ring Mod Amt: "0.0 %"-"100 %" | Ring Mod Freq: "1.00 Hz"-"5.00 kHz" |
| Sub Osc | Sub Amount: "0.0 %"-"100 %" | Sub Frequency: "30.0 Hz"-"120 Hz" |
| Noise | Noise Amount: "0.0 %"-"100 %" | Noise Color: "180 Hz"-"15.0 kHz" |

- Formats, the same for every knob so far: times and frequencies show 3
  significant figures (ms below 1 s, kHz from 1 kHz); percentages show one
  decimal below 10 and none from 10, by size, so "-6.7 %" but "-14 %"; no
  "+" sign.
- Mismatches in LiveChopper today: `formatHz` prints "1.0 Hz" where Move
  shows "1.00 Hz" (it matters from 10 Hz down, for Ring Mod Freq), and
  `formatPercent` would print "-14.0" for a negative value (Pitch Env
  Amount). LiveChopper exports 8-Bit Decay as 5.0, which Move shows as
  "Off", so 8-Bit today is undecayed.
- Loop is the one effect whose knobs are the reverse of its field pair:
  Offset on Knob 7, Length on Knob 8 (confirmed 2026-11-09).

Screen session 4 (2026-11-10, the Filter & Setup page; Set 25 holds the raw
values):

- Titles: "Filter Frequency", "Filter Resonance", "Filter Gain" (Peak Gain,
  only while the type is Peak), "Filter Type", "Envelope Mode".
- Filter Type steps one type a click in LiveChopper's order, Low-Pass 24
  the default; Envelope Mode is Trigger or Gate, one a click.
- Resonance: linear 0-0.9, 0.688% a click (Set 25: 1 click 0.00688, 10
  clicks 0.0688, exact), shown "0.0 %"-"90 %". LiveChopper steps 1%
  (Shift 0.1%).
- Peak Gain: stored linear (1.0 = 0 dB), as the export already does, but
  the knob is linear in dB: 24 dB over 131 steps, 0.18 dB a click (10
  clicks +1.84 dB, exact). Shown "-12 dB", "-0.2 dB", "0.0 dB", "12 dB": the
  percentage rule, no "+". LiveChopper steps 0.5 dB (Shift 0.1) and
  `formatGain` prints "+1.5 dB".
- Shift on Frequency, Resonance and Peak Gain: a tenth of a step, skipped
  until the display changes. The exact count is sometimes one or a few
  more than rounding predicts (Resonance from 0 took 2 fine steps where 1
  already shows "0.1 %"; likewise Stretch Factor, Loop Offset, FM Amount
  and Peak Gain from their ends). Not explained; plain rounding is close
  enough to copy.
- Knobs 5-8, which LiveChopper leaves unused or gives to Gain: 5 "Choke"
  (Off, On), 6 "Velocity >" and a target (Filter, Attack, Hold, Decay,
  FX 1, FX 2), 7 that target's amount ("-100 %"-"100 %", each target keeps
  its own), 8 "Pan" ("50 Left", "Center", "50 Right"). Nothing to change:
  SPEC leaves choke and velocity out on purpose, and Gain stays on Knob 8.

## Other ideas (not committed to)

- Snap chops to the set's tempo.
- Use the right-hand 16 pads, which do nothing today.
- Per-pad sound settings before export. SPEC currently leaves these to the
  drum rack on purpose.

## Maintenance

- A weekly scheduled CI run, so a new Schwung release is tested even while
  this repo is idle.
- The help.json fix waiting for a release goes out with step 1's release
  instead of a v0.6.3.
