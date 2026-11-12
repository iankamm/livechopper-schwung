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
| Punch | ducking with a fixed attack, emphasising the transient; Release is how long the gain reduction takes to return | a boost of up to +12 dB at the start |
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
5. Read the plots and numbers for what each effect does differently.
6. Tune each stand-in and record the decision here.

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

Plus one real kick or snare, for a last check by ear once the numbers
match.

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
| Punch | sine_441, click_train | Amount 50 %, 100 %; Release 60 ms, 120 ms, 1 s |
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
