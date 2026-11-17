# Design notes

Findings from studying the framework and schwung-waveform-editor (v0.7.3),
2026-10-15, and from measuring Move's Drum Sampler, 2026-11-09 to 12
("Move's Drum Sampler, measured"). These are design-time findings; where
they differ from SPEC.md, SPEC.md is authoritative. Planned work is in
PLAN.md.

## Chop timing: DSP owns pad input

- In an interactive tool (overtake_mode 2) the shim delivers internal pad
  note-on/off to the tool DSP's `on_midi` on the audio thread
  (schwung `src/schwung_shim.c`, "Deliver internal cable-0 note events").
  The same events also reach `onMidiMessageInternal` in ui.js.
- So chop logic lives in the DSP: on note-on, read the playhead right there
  and split. The UI only mirrors state (LEDs, screen) by polling get_param.
- Granularity: `on_midi` runs between blocks, so T is the playhead at the
  block boundary where the note is processed (128 frames, ~2.9 ms). There is
  no intra-block timestamp in the API. SPEC item 7 states this.
- The waveform editor's "Lazy" chop mode does NOT do this: it reads `playPos`
  in the UI (polled per tick), so its chops are tick-accurate at best. Don't
  copy it.

## Realtime safety

- The waveform editor loads WAVs with fopen/malloc inside `set_param`, which
  breaks the rules in plugin_api_v1.h. Don't copy that loader as-is.
- As built: `set_param("file_path")` only copies the path and signals a worker
  thread (SCHED_OTHER, pinned to cores 0-2) created in `create_instance`. The
  worker loads and publishes a buffer pointer; render plays silence until it
  lands. Old buffers are freed by the worker, never on the audio thread.
- For an overtake tool, create/destroy run on the shim worker, so allocation
  and pthread_create there are fine.

## Export (drum rack preset)

What the waveform editor's preset writer showed, which `src/drum_rack.mjs`
grew from. SPEC "Export Drum Preset" lists every field LiveChopper writes.

- The waveform editor's `saveDrumRackPreset()` (ui.js) writes an
  `.ablpreset` JSON to `/data/UserData/UserLibrary/Track Presets/`, in
  pure JS.
- It uses one WAV for all pads: every drumCell points at the same
  `sampleUri` with `Voice_PlaybackStart` / `Voice_PlaybackLength` as
  fractions of the file. LiveChopper does the same.
- Units, from a real Move set (schwung tests/fixtures/song_abl_sample.json):
  envelope times are seconds (ranges under "Knob curves"); Move's own kits
  use hold 0.001 with the decay doing the work. Volume around -12.
- Choke: each pad has `drumZoneSettings.chokeGroup`; the waveform editor
  sets 1 on all 16 pads, so all pads choke each other.
- Transpose: `Voice_Transpose` per drumCell, so a global transpose can be
  exported.
- Envelope: the drumCell envelope is `Voice_Envelope_Attack/Hold/Decay` with
  `Voice_Envelope_Mode: "A-H-D"`. The global envelope maps onto these
  fields (A-H-D, or A-S-R when gated).
- The preset always has 16 chains (receivingNote 36-51); unused pads get
  `speakerOn: false`.

## Move's Drum Sampler, measured

What LiveChopper's knobs and effects were built from (SPEC "Knob model",
"Effect"), read from Move Sets and Move's screen, 2026-11-09 to 12. Work
still to do is in PLAN.md. The Sets, takes and manuals are in
`.claude/recordings/` and `.claude/ref/`, local only.

### Effect fields

In Move's order:

| Effect | `Effect_Type` | Knob 7: field, range | Knob 8: field, range | Move's defaults (Knob 7, 8) |
|---|---|---|---|---|
| Stretch | "Stretch" | StretchFactor: 1-20 | StretchGrainSize: 0.005-0.3 | 1.0, 0.1 |
| Loop | "Loop" | LoopOffset: 0-1 | LoopLength: 0.01-0.5 | 0.0, 0.3 |
| Pitch Env | "Pitch Env" | PitchEnvelopeAmount: -1 to +1 | PitchEnvelopeDecay: 0.005-2 | 0.0, 0.3 |
| Punch | "Punch" | PunchAmount: 0-1 | PunchTime: 0.06-1 | 0.0, 0.12016 |
| 8-Bit | "8-bit" | EightBitResamplingRate: 1000-30000 Hz | EightBitFilterDecay: 0.01-5 | 14080, 5.0 |
| FM | "FM" | FmAmount: 0-1 | FmFrequency: 10-4500 Hz | 0.0, 1000 |
| Ring Mod | "Ring Mod" | RingModAmount: 0-1 | RingModFrequency: 1-5000 Hz | 0.0, 1000 |
| Sub Osc | "Sub Osc" | SubOscAmount: 0-1 | SubOscFrequency: 30-120 Hz | 0.0, 60 |
| Noise | "Noise" | NoiseAmount: 0-1 | NoiseFrequency: 180-15000 Hz | 0.0, 10000 |

Field names drop the `Effect_` prefix. Times are seconds; units are not
stored in the set file. Sources:

- `Effect_Type` strings: real Move presets (Schwung's and the waveform
  editor's test data), and Set 18 (a 909 Kit), which confirmed "Noise"
  and "Loop".
- Ranges: Set 18 has two pads per effect, one with each setting turned
  fully down and one fully up. Set 19 (a Viral Kit) does the same for
  Noise and for 8-Bit's Filter Decay. Where a fully-down or fully-up value
  equals the default (Noise Amount 0, 8-Bit Filter Decay 5), the default
  sits at that end of the range.
- Defaults: the 909 Kit preset's values (`presetValue` in the set), which
  match Move's set fixture in Schwung. Loop Offset's default is 0.0 in
  both; `src/drum_rack.mjs` wrote 0.02 until PLAN step 2 fixed it.

Move's manual (Drum Sampler, Main Bank) puts each effect's two settings on
Knobs 7 and 8 and lists the effects in this order: Stretch, Loop, Pitch
Env, Punch, 8-Bit, FM, Ring Mod, Sub Osc, Noise. It has no Off. Which
setting sits on which knob is from screen session 3. For every effect but
Loop that is also the order of its field pair in the set file; Loop's
pair is stored Length first, Offset second, the reverse of its knobs.

### Knob curves (Sets 20, 21)

Set 20 (a Citizen Drop Kit) has one pad per effect with both settings
turned one click from the default: up, except 8-Bit Filter Decay, whose
default is its maximum, so that one went down. Every click moves the knob
by the same amount: 0.7645% of its travel (0.00764526), about 131 clicks
end to end. Each setting maps knob position p (0-1) onto its range with
one of these curves:

| Curve | value = | Settings |
|---|---|---|
| linear | min + (max-min)·p | Punch, Ring Mod, Sub Osc and Noise Amount; Pitch Env Amount |
| log | min·(max/min)^p | 8-Bit Rate, 8-Bit Filter Decay, FM Frequency, Sub Osc Frequency |
| square | min + (max-min)·p² | Stretch Grain Size, Loop Length, Noise Frequency, Stretch Factor, Loop Offset |
| cube | min + (max-min)·p³ | Pitch Env Decay, Punch Time, FM Amount |
| 5th power | min + (max-min)·p⁵ | Ring Mod Frequency |

Each fits its click to within 1%. Set 21 (a Frantik Kit) turned Stretch
Factor, Loop Offset, FM Amount and Ring Mod Frequency 10 slow clicks, which
settled those four. Stretch Factor and Loop Offset explain their odd first
click: Move keeps stepping the knob until the value on screen changes.
Stretch Factor shows 2 decimals, so 1.00 to 1.01 takes 3 steps; Loop
Offset shows a percentage with 1 decimal. Both match all ten clicks
exactly. FM Amount skips too (its clicks land on knob steps 12 and 28, both
exact on the cube curve), but no simple rounding of its value explains
which steps it skips, so its on-screen format decides that.

Set 21 also measured the envelope and filter frequency, all log curves with
exactly one knob step per click:

| Setting | Move |
|---|---|
| Attack | log, 0.0001-20 s |
| Hold | log, 0.001-60 s (the top shows "Inf") |
| Decay | log, 0.001-60 s (the top shows "60.0 s") |
| Filter Frequency | log, 30 Hz-22 kHz, x1.0517 a click |

The envelope ranges are from Set 19 (pads 5 and 6, fully down and fully
up). Set 18's 909 Kit first showed Decay goes past 10 s, with decays of
12.87 s and 13.92 s; Schwung's Move set fixture has 10.0.

The filter's 10-click pad landed on 11 steps, which the display rule can't
explain at those values; probably one extra click. Its single click is
exact.

The rule for every Move knob measured (Sets 20-25): 131 equal knob steps
across the range (0.00764526 each, the last one short), a curve per
setting, a tenth of a step with Shift, and steps skipped until the
displayed value changes. Length is the one knob seen that doesn't skip.

### Every knob follows Move

Every knob that mirrors a Move control follows Move's range, curve, step
size, Shift fine step and on-screen format (PLAN steps 1 and 2 built it).
Gain (Filter & Setup Knob 8) is LiveChopper's own, since Move has no Gain
knob there: Move's drum sampler range (-70 to +24 dB) with Simpler-like
steps (0.5 dB, Shift 0.1, 2 dB below -24 dB). Its readout follows Move's
rule anyway: no "+" (decided 2026-11-12).

| Knob | Range | Curve and step | Display |
|---|---|---|---|
| Main 1 Transpose | -48 to +48 st (Set 22, screen) | 1 st a click | "12 st", "-12 st", "0 st" (no +) |
| Shift Main 1 Detune | -50 to +50 ct (Set 22, screen) | 1 ct a click | "5 ct", "-50 ct" (no +) |
| Main 2 Start | sample length | 1 screen column a click | no number: the waveform, the marker and "Start" |
| Shift Main 2 Zoom | LiveChopper's own (decided 2026-11-09) | Move has two levels | - |
| Main 3-5 Attack, Hold, Decay | 0.10 ms-20.0 s / 1.00 ms-Inf / 1.00 ms-60.0 s | log, 131 steps, one value a click (Sets 21, 23) | 3 significant figures: "0.10 ms", "10.6 ms", "110 ms", "1.03 s", "20.0 s"; Hold's top is "Inf" |
| Main 5 Length (Move: Shift) | 0-100% of the sample | Move: linear, 0.7645% of the sample a click, no skipping (Set 23). LiveChopper keeps 1 screen column a click (decided 2026-11-09) | "0.0 %"-"9.9 %", then "11 %"-"100 %"; over the waveform |
| Main 6 Effect | nine effects, no Off | one effect every 4 detents (see below) | "Playback Effect", the effect's name, and a bar for its place in the list |
| Main 7-8 effect settings | see "Effect fields" | see "Knob curves" | see screen session 3 |
| Filter 1 Frequency | 30 Hz-22 kHz | log (Set 21) | "Filter Frequency", "30.0 Hz"-"22.0 kHz" |
| Filter 2 Resonance / Peak Gain | 0-0.9 / -12 to +12 dB | both linear (Peak Gain linear in dB), 131 steps (Set 25) | "Filter Resonance" "0.0 %"-"90 %"; "Filter Gain" "-12 dB"-"12 dB" |
| Filter 3 Type, 4 Envelope Mode | four types / Trigger, Gate | one item every 4 detents | "Filter Type": Low-Pass 12, Low-Pass 24, High-Pass 24, Peak; "Envelope Mode": Trigger, Gate |

The list knobs (Effect, Type, Envelope Mode) move one item every 4
detents (decided 2026-11-13). This is Schwung's own list gate
(knob_engine.mjs ENUM_DELTA_DIV): turning back drops a partial turn, and
Shift lifts the gate to one item a detent. A Move knob sends about 210
detents a rotation (Schwung's EC4_SURFACE.md), so at one item a detent all
nine effects went by in about 15 degrees. Move's own rate for its lists is
unmeasured: the screen captures have frames but no encoder counts, and a
Set only keeps the end value.

Shift's fine step (the manual mentions it for Attack, Hold, Filter
Frequency and Resonance): on Attack and Hold it is a tenth of a knob step,
skipped until the display changes (Set 23: Attack 0.10 to 0.11 ms took 6
fine steps, Hold 0.80 to 0.81 s took 1; both exact). All 18 effect
settings have the same fine step: Set 24's one Shift click on each landed
on a whole number of tenth-steps (1 to 3 for most, 25 for Stretch Factor,
31 for Loop Offset and 112 for FM Amount, which start where the display is
coarse). Filter Frequency, Resonance and Peak Gain have it too (Set 25).
Decay and Length have none (screen session 2). The exact count is
sometimes one or a few more than rounding predicts (Resonance from 0 took
2 fine steps where 1 already shows "0.1 %"; likewise Stretch Factor, Loop
Offset, FM Amount and Peak Gain from their ends). Not explained; plain
rounding is close enough to copy.

Screen session 1 (2026-11-09, `.claude/tools/capture_display.py`; Set 22
holds the raw values):

- Knob readout layout: the name on the top line, a bar under it filled from
  the left in proportion to the value (from the minimum, even for Transpose
  and Detune), the value at bottom left, and the sampler icon at bottom
  right.
- Turning fast skips values: a slow click moves Transpose 1 st, a fast
  turn 2-3. Whether LiveChopper does the same is unchecked (PLAN
  "Open").
- Start: the marker is a full-height line with a flag at the top, moving
  one screen column a slow click. Zoomed in, it travels to the screen's
  centre and then the waveform scrolls under it. Only two zoom levels
  showed up (the zoomed view about 2.5x the full one).

Screen session 2 (2026-11-09; Set 23 holds the raw values):

- Attack, Hold and Decay each swept end to end, one value a click, every
  value distinct. The ratios per click match the log curves exactly
  (Attack x1.0978, Hold and Decay x1.0878). The knob sits on multiples of
  0.00764526 clamped to 1, so the last click is short: Hold goes 56.1 s
  then Inf.
- Display: 3 significant figures, in ms below 1 s and in s from 1 s.
- Length: the screen is the waveform with a bracket at each end of the
  played region, "Length" at bottom left and the value at bottom right; no
  bar or icon. Pad 5's one click took Voice_PlaybackLength from 1 to
  0.992355, one knob step of the whole sample, and the sweep shows each
  click moves 0.7645% even where the display repeats ("11 %" twice), so
  Length doesn't skip. A chop is often a small part of a long recording,
  where 0.76% of the whole is a big jump (0.92 s on a 2-minute recording),
  so LiveChopper keeps its column step (decided 2026-11-09): zoomed out it
  nearly matches Move's (1/124 of the sample against 1/131), and zoomed in
  it gets finer, as Move's own Start knob does.
- Shift on Knob 5: on Move, holding Shift switches the knob between Decay
  and Length, so neither has a fine step (Set 23's pads 4 and 6 stayed at
  their defaults). LiveChopper copies it (decided 2026-11-09).

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

Screen session 4 (2026-11-10, the Filter & Setup page; Set 25 holds the raw
values):

- Titles: "Filter Frequency", "Filter Resonance", "Filter Gain" (Peak Gain,
  only while the type is Peak), "Filter Type", "Envelope Mode".
- Filter Type steps one type a click in LiveChopper's order, Low-Pass 24
  the default; Envelope Mode is Trigger or Gate, one a click.
- Resonance: linear 0-0.9, 0.688% a click (Set 25: 1 click 0.00688, 10
  clicks 0.0688, exact), shown "0.0 %"-"90 %".
- Peak Gain: stored linear (1.0 = 0 dB), but the knob is linear in dB:
  24 dB over 131 steps, 0.18 dB a click (10 clicks +1.84 dB, exact). Shown
  "-12 dB", "-0.2 dB", "0.0 dB", "12 dB": the percentage rule, no "+".
- Knobs 5-8, which LiveChopper leaves unused or gives to Gain: 5 "Choke"
  (Off, On), 6 "Velocity >" and a target (Filter, Attack, Hold, Decay,
  FX 1, FX 2), 7 that target's amount ("-100 %"-"100 %", each target keeps
  its own), 8 "Pan" ("50 Left", "Center", "50 Right"). SPEC leaves choke
  and velocity out on purpose, and Gain stays on Knob 8.

### Stretch and Loop stand-ins (PLAN step 3, 2026-11-11)

Live's manual (Drum Sampler, 31.4.2 Playback Effects; the same device as
Move's) is the only description: Stretch "changes the sample's length
without altering its pitch", Factor being "a multiple of the original
playback speed" and Grain Size the grain in ms; Loop "repeats a portion of
the sample", Loop Offset setting "the loop start point relative to the
sample start" and Loop Length its duration in ms. The design (SPEC
"Effect" has what it does), and why:

- Both run inside one voice path shared by the playing voice and the choke
  tail (read, 8-Bit, effect, filter, advance), and each voice knows its
  slice's start as well as its end, kept up to date when a chop, delete or
  marker nudge changes the slice under it.
- Stretch: a grain restarts early enough to end inside the slice, or the
  last grains of a long stretch run into silence. The envelope runs in
  real time, so a short Decay cuts a long stretch. Plain grains drift the
  pitch a little where the grain is short (5 ms grains on a 441 Hz tone at
  Factor 20 read 423 Hz), lo-fi as Live's manual describes Move's.
- Loop: the level dips for 1.5 ms either side of each wrap rather than
  crossfading, because a crossfade would need audio from before the loop,
  which a loop at the very start doesn't have. A playhead left behind a
  loop moved by the knobs plays on into it.
- Checked by ear on the Move (2026-11-11): Factor 2 plays twice as long,
  and Loop starts at its Offset (LiveChopper first played from the slice
  start into the loop, and was changed to match). Neither sounds like
  Move's own.

### Stretch and Loop on Move (Set 52)

Set 52, 2026-11-17 (`tools/fxlab/sets/set52_stretch_loop_scout.json`,
take and saved Song.abl in `.claude/recordings/set52/`; the take is cut at
96 s as `take_cut96.wav` because pad 16 loops on, split in `set52/sl/`).
Both are simple, deterministic and unlike LiveChopper's stand-ins. A
numpy model of each (session scratchpad `s52/model.py`) fits Move as
below; the dry Low-Pass 24 and the Attack were left out of it.

Stretch:
- Grains don't overlap. Grain k starts at output frame k·H, where H is
  floor(Grain × 44100) frames (5 ms is 220, not 220.5: pad 5's click
  copies are 209 apart, 220 × (1 - 1/20)). It reads from the playhead,
  p_k = k·H·r/F (r the pitch ratio, F the Factor), and from there at r,
  interpolating linearly between frames (pad 4's copies alternate full and
  0.516 high, on whole and half frames).
- Each grain fades in linearly over its first 44.1 frames (1 ms) and out
  over its last 44.1, so the level dips to 0 at every boundary (pad 7;
  pad 5's copies trace both ramps).
- H doesn't follow Transpose; the playhead and the read inside a grain do
  (pad 9 at +12: copies every 4410 frames, at mid-grain).
- Deterministic: pad 10 repeats pad 4 bit for bit.
- Fit: position_ramp at Factor 2 (pad 7) 16.6 LSB rms (53 dB under), sine
  at Factor 20 / 5 ms (pad 8) 54 LSB (45 dB under); click pads 40-57 LSB,
  about the Low-Pass 24's ring after each click.
- Open: at Factor 2 (pads 3, 9) the click copies fall ~12.5 LSB for each
  100 ms of the sample read (24321 to 24098 over the sample; every source
  click is 29204), not seen at Factor 20. Untraced, 0.08 dB.

Loop:
- Plays from the sample's start, not from Offset (pads 12, 13, 15, 16 all
  read from frame 0, Song.abl's Offset 0.25 / 0.9). That contradicts the
  check by ear of 2026-11-11 ("Loop starts at its Offset"), which the
  stand-in follows.
- When the read reaches Offset·length + Length, a new read starts at
  Offset·length; the old one carries on past the loop's end, and the two
  crossfade linearly over 397 frames (9.0 ms) of the sample's time.
  Length is in the sample's time too, so both follow Transpose (pad 15,
  +12: a 6616-frame loop, a 198-frame crossfade). 10 ms is 441 frames
  (pad 14).
- Past the sample's end the loop reads silence (pad 16: Offset 90 %,
  500 ms plays 200 ms of sample, 300 ms of silence, then wraps). At Hold
  Inf it loops on (pad 16 still looping at the take's end, 72 s on).
- Fit: position_ramp pads 11-13, 15, 16 to 0.6-3.4 LSB rms past the
  Attack; sine at 10 ms (pad 14) 82 LSB (42 dB under). Pad 16 shows
  ~19 LSB where each pass reaches the sample's end: likely Move's end
  fade ("Move's dry path").

### Move's dry path (Set 28)

Set 28, 2026-11-12: the six sounds at Stretch 1.00, Attack minimum, Hold
Inf, Low-Pass 24 at 22 kHz, pad Volume -12 dB, Velocity to Volume 0.5,
Full Velocity (`.claude/recordings/set28/`):

- Gain -1.45 dB (0.8465) on every sound, the same in both volumes, and
  flat to +-0.02 dB from 30 Hz to 19.5 kHz. It isn't the pad's -12 dB, so
  each Set's dry take sets the reference level; effects are compared
  relative to it.
- That level depends on Attack: 0.8465 at the 0.10 ms minimum, 0.9311
  (-0.62 dB, +0.83 dB on the minimum) at 1.0 ms, in both Set 31 and Set 32
  (whose position_ramp pads had 1.0 ms). `fxlab.py` sets each pad's level
  from the dry pads with the same Attack.
- Attack at its minimum (0.10 ms) is a linear ramp over the first 4
  frames (0.25, 0.49, 0.76, 0.99), so a click on frame 0 almost vanishes.
  LiveChopper's Attack 0 starts at full level.
- The end of the sample fades out over its last ~417 frames (9.5 ms),
  S-shaped (gain 0.79 300 frames before the end, 0.41 at 200, 0.10 at
  100). LiveChopper's slices stop dead.
- Low-Pass 24 at 22 kHz is a real filter, not a bypass: a click is
  followed by a ring at Nyquist (+-780 after a 24k click, alternating each
  frame, falling ~2% a frame). Inaudible; LiveChopper bypasses it.
- position_ramp passes cleanly: gain and offset alone fit it to 0.5 LSB
  rms, so each value gives the frame read to ~2 frames. Usable for Loop,
  Pitch Env and FM (not Stretch, whose crossfading grains mix two
  positions; click_train shows its grains).
- `tools/fxlab/fxlab.py` on this take (render of plugin.c at the same
  settings): gain 0.8462, residual over the steady part 5.9 LSB (sine),
  2.4 LSB (ramp), pitch 0.00 st, read position 0.18 ms rms, bands 0.00 dB.
  What remains is the attack ramp, the end fade and the Nyquist ring, and
  the dry pads pass every metric of PLAN's "When an effect is done" with
  room to spare (bands 0.01 dB, pitch 0.85 ct max, position 0.35 ms max),
  so those don't need matching first. Set 28's first two takes, recorded
  without Move->Schwung, went through the Set template's "Punch Glue"
  compressor, "Analog Clip" and Limiter and Move's speaker enhancer (+6 dB
  at 150 Hz, a dip at 500 Hz, the ramp reduced to a blip).

### Punch (Sets 29-31)

Done 2026-11-12: fitted on Sets 29 and 30, accepted on Set 31 (seed 1112,
references in `tests/move_refs/punch/`), and the preview as the Move
plays it passes. Live's manual describes Punch as ducking with a fixed
attack, emphasising the transient, Release being how long the gain
reduction takes to return.

Set 29: one Drum Rack, 15 pads in note order, played about 3 s apart
(`.claude/recordings/set29/`; Amount 50 % is 0.4969 on Move's knob):

| Pads | Sound | Punch |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00): the level reference |
| 2-7 | sine_441 | Amount 50 % and 100 %, each at Release 60 ms, 120 ms (default), 1.00 s |
| 8-13 | click_train | the same six |
| 14 | sine_441_quiet | dry |
| 15 | sine_441_quiet | Amount 100 %, Release 120 ms |

Move's Punch is a fixed gain envelope from note-on, nothing like the
stand-in's boost at the start it replaced:

- Makeup: the start and everything after the release sit at 1 + Amount³
  of the dry level (1.1227 = +1.00 dB at 0.4969, exact to 4 digits; 2.000
  = +6.02 dB at 100 %). So the transient keeps that level and the body is
  ducked below it.
- Not level-dependent: sine_441_quiet's curve matches sine_441's to 0.1
  dB. Nor retriggered: each click of click_train lands on the sine's curve
  for the same settings.
- Duck attack: the same for every Release. Barely moving at 2 ms, halfway
  down at 14-18 ms, 95 % of the way by ~50 ms, done by ~80 ms.
- Release: back to the makeup level at about Release after note-on.
- Ceiling: at 100 % click_train settles at +2.4 dB, not +6: see Set 30.

Set 30: the same baseline and timing, 12 pads (`.claude/recordings/set30/`;
Amounts 9.86, 25.4, 75.1, 90.1 %, Releases 252 and 506 ms):

| Pads | Sound | Settings | For |
|---|---|---|---|
| 1 | sine_441 | dry | the level reference |
| 2-5 | sine_441 | Punch 9.9 %, 25 %, 75 %, 90 %, Release 1.00 s | depth, makeup and the attack against Amount |
| 6 | sine_441 | Punch 100 %, 1.00 s | Set 29's pad 7 again: do takes repeat |
| 7-8 | sine_441 | Punch 50 %, 100 %, Release 252 ms | the release's shape |
| 9-10 | sine_441 | Punch 50 %, 100 %, Release 506 ms | the release's shape |
| 11 | sine_441 | Stretch 1.00, Filter Peak, 434 or 457 Hz, Peak Gain 12 dB | the ceiling without Punch |
| 12 | click_train | Punch 75 %, 1.00 s | the ceiling again |

- Repeatable: pad 6 matches Set 29's pad 7 to 0.0006 dB rms (0.008 dB
  max). Move's Punch is deterministic.
- Makeup 1 + Amount³ holds at every Amount (+0.01, +0.14, +3.07, +4.76 dB
  predicted; +0.0, +0.1, +3.0, +4.7 measured on the 2 ms start).
- Depth: gain = makeup x max(1 - Amount x env(t), 0.15), env rising from
  0 to 1 at note-on and falling back to 0 over the Release. The bottom
  against the makeup is 0.902, 0.750, 0.501, 0.248, 0.150, 0.150 at 9.9,
  25, 50, 75, 90, 100 %: 1 - Amount down to the 0.15 clamp. The clamp
  explains Set 29's flat bottom at 100 % and why 90 % ducks deeper than
  100 % in absolute terms (same clamp, less makeup).
- Release: (1 - g/makeup) / Amount over t/Release is one curve at 1 s for
  every Amount, to 0.02: 0.98 at 0.4 R, 0.95 at 0.5, 0.89 at 0.6, 0.79 at
  0.7, 0.63 at 0.8, 0.40 at 0.9, 0.08 at 1.0, 0 by 1.05 R. At shorter
  Releases its tail runs past R (env 0.14 at R for 506 ms, 0.24 for 252,
  0.41 for 120, 0.54 for 60), as if a fixed smoothing acts on top.
- Attack: faster with more Amount (env 0.14 at 10 ms at 9.9 %, 0.38 at
  100 %), so not one curve in linear gain.
- Ceiling: pad 11 (no effect, Peak +12 dB) flattens at exactly 31918
  with a soft knee, so the ceiling isn't Punch's. It is two clips: Move
  clips hard at full scale after the effect and before its filter (the
  ring after a clipped click is 1.348 x dry at both 75 % and 100 % Punch,
  which is 32767 / 24327: the click clipped to full scale, then filtered),
  and Schwung's capture then soft-clips above 29204 (PLAN, "When an effect
  is done"). LiveChopper also clips at full scale, but after its filter,
  which matters only when the filter rings.

The model (`src/dsp/plugin.c`, `fx_frame`), fitted by least squares to all
14 sine pads of Sets 29 and 30 at once, through the same 100-frame window
that measures Move (rms 0.061 dB, worst 0.89 dB):

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
  What fails is clipping: Set 29's 100 % click pads (bands 1.36 dB: Move's
  take was soft-clipped by Schwung's capture as well, our render was not),
  Set 30's 75 % click pad on the limit (0.99 dB), and Set 30's Peak pad.

Set 31, the acceptance Set (`fxlab.py accept-set Punch --seed 1112`,
drawn after tuning), plus two pads at Transpose +12 for whether Punch's
times follow the pitch, as "Envelope Follows Pitch" might make them. Both
repeat Set 30 settings, so a halved time would show directly:

| Pad | Sound | Settings |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00) |
| 2 | sine_441 | Punch Amount 28 %, Release 75.1 ms |
| 3 | sine_441_quiet | Punch Amount 75 %, Release 60.0 ms |
| 4 | drum_synth | Punch Amount 83 %, Release 420 ms |
| 5 | sine_441 | Punch Amount 57 %, Release 751 ms |
| 6 | sine_441_quiet | Punch Amount 17 %, Release 192 ms |
| 7 | drum_synth | Punch Amount 83 %, Release 823 ms |
| 8 | sine_441 | Punch Amount 6.9 %, Release 60.1 ms |
| 9 | sine_441_quiet | Punch Amount 69 %, Release 941 ms |
| 10 | sine_441 | a copy of pad 2 |
| 11 | sine_441 | Transpose 12 st, Punch Amount 100 %, Release 252 ms (Set 30 pad 8) |
| 12 | sine_441 | Transpose 12 st, Punch Amount 50 %, Release 506 ms (Set 30 pad 10) |

- Recorded 2026-11-12 with two departures: pad 5's Release is 751 ms (750
  isn't a step on Move), and every pad's Attack is 1.0 ms, not the minimum
  (the render reads both from the Set, so the comparison holds).
- `fxlab.py check`: 12 of 12 pass, gain worst 0.97 dB (pad 11), bands
  worst 1.04 dB (pad 4, drum_synth), pitch under 1 cent. Pads 11 and 12
  pass with Punch's times unchanged by Transpose, so they don't follow the
  pitch. `fxlab.py refs .claude/recordings/set31/punch --seed 1112` saved
  them as `tests/move_refs/punch/`, which `test.sh` checks.
- Preview on the Move (2026-11-12, `.claude/recordings/preview1/`, a
  Skipback take of LiveChopper playing sine_441 at Set 30 pads 1, 8, 10
  and 2): against plugin.c's render, 4 of 4 pass (gain worst 0.28 dB,
  bands 0.06 dB, pitch 0); Move's own Set 30 pads against it, 4 of 4
  pass (gain worst 0.47 dB, bands 0.26 dB). The preview plays at unity,
  1.45 dB above Move's dry level (0.8465); `check` compares each take at
  its own level, so this isn't part of the verdict.
- Device: `fxlab.py device-check` renders the pads of Sets 28-30 on the
  Move (plugin.c built with build.sh's flags, the Move's libm) and
  compares them with the host's: all 56 renders identical, bit for bit.
  What `check` measures on the host is what the Move plays.
- Listening A/B, 2026-11-16 (owed since Punch was done before that
  step): Set 31's 12 pads played in chop mode in three Skipback takes
  (`.claude/recordings/preview6/`). Against the renders, exact at the
  positions played (`played.json`: 28 % and 83 % landed one grid position
  under Set 31's, 50 % two units under; Set 31's Punch times sit ~5e-4
  off the grid, the preview plays the grid). Against Move, 12 of 12
  (gain worst 0.10 dB rms, bands 0.20). The 12 st, 100 % pad reaches full
  scale: the render hard-clips, the take holds its peaks to 31918.
  No difference heard on any of the 12 pairs.

### Pitch Env (Sets 32, 33)

Fitted 2026-11-13 on Set 32 (`.claude/recordings/set32/`): one Drum Rack,
16 pads in note order, about 4 s apart (a downward bend reads the 2 s
sounds slower, so they outlast 2 s), Attack at its minimum except on the
position_ramp pads (1.0 ms, read from the Set).

| Pad | Sound | Pitch Env |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00): the level reference |
| 2-5 | sine_441 | Amount 100 %, 50 %, 25 %, 10 %, Decay 2.00 s |
| 6-7 | sine_441 | Amount -100 %, -25 %, Decay 2.00 s |
| 8-10 | sine_441 | Amount 100 %, Decay 300 ms, 50.2 ms (50.0 isn't a step on Move), 5.00 ms |
| 11 | position_ramp | dry: the read-position reference |
| 12-13 | position_ramp | Amount 100 %, -100 %, Decay 300 ms |
| 14 | position_ramp | Amount 50 %, Decay 2.00 s |
| 15 | position_ramp | Transpose 12 st, Amount 100 %, Decay 300 ms |
| 16 | sine_441 | a copy of pad 8 |

- **Depth:** 100 % is 48 semitones, linear in Amount and mirrored below
  zero. An exponential fitted to each 2 s pad's pitch from 100 ms on
  starts at 48.0-48.9 semitones per 100 % (pads 2-7).
- **Shape:** exponential in semitones, falling to 1/1000 at the Decay:
  the same fits give a time constant of Decay / 6.90-6.92 (ln 1000 is
  6.908) on every 2 s pad, and 300 ms gives 43.7 ms (Decay / 6.87).
- **One frame in:** Move's envelope has already taken one frame's step on
  the first frame. Without that, every +100 % pad reads ~15 frames less
  than ours by the end of the bend (r(0) - 1 at 16x), whatever the Decay,
  and Decay 5 ms fails pitch by 494 ct max; with it, 1.2 ct. An offset of
  0.75 or 1.25 frames is clearly worse.
- **Transpose:** Decay doesn't follow it (pad 15 rendered at 300 ms
  matches Move to 0.6 LSB past the attack; at 150-250 ms it is off by
  94-286 ms). But
  Move's Attack does: pad 15's 1.0 ms Attack ramps in ~22 frames, half
  of pad 12's 44, so the voice envelope's times follow Transpose
  (Voice_PitchToEnvelopeModulation is on). LiveChopper's don't yet (PLAN
  "following Transpose"), and that mismatch in the first 0.5 ms is all
  that fails pad 15: past 400 frames it matches to 0.6 LSB at lag 31.
- **Repeatable:** pad 16 gives exactly pad 8's numbers.
- `fxlab.py check` with this model: 15 of 16 pass (pad 15 above), pitch
  worst 2.4 ct (pad 9), position worst 0.13 ms.

The pitch metric on a fast bend: the zero-crossing pitch lags it (Move's
stored pitch curve isn't its true pitch there), but both takes go through
the same tracker, so it cancels in `check`. `tests/fxlab_selftest.py`
part 6 keeps that so: a render against a copy of itself with Move's
capture differences (the 4-frame attack ramp, Low-Pass 24 at 22 kHz)
passes, and 47 semitones for 48 or Decay 5.5 ms for 5 ms fail. So the
semitones were read from the 2 s pads, and the short end was fitted by
rendering candidates through plugin.c and the metric, not by fitting the
stored curve.

Set 33, the acceptance Set (`fxlab.py accept-set "Pitch Env" --seed 1113`,
drawn after tuning), recorded 2026-11-13: Attack at its minimum, Hold Inf,
Low-Pass 24 open, Transpose 0, about 3 s apart.

| Pad | Sound | Pitch Env |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00) |
| 2 | sine_441 | Amount -94 %, Decay 22.5 ms |
| 3 | position_ramp | Amount 68 %, Decay 7.99 ms |
| 4 | drum_synth | Amount -97 %, Decay 1.75 s |
| 5 | sine_441 | Amount -77 %, Decay 366 ms |
| 6 | position_ramp | Amount -88 %, Decay 366 ms |
| 7 | drum_synth | Amount 77 %, Decay 6.18 ms |
| 8 | sine_441 | Amount 53 %, Decay 633 ms |
| 9 | position_ramp | Amount -91 %, Decay 6.99 ms |
| 10 | sine_441 | a copy of pad 2 |

- Drawn Decays that aren't steps on Move: pad 3's 8.01 ms became 7.99,
  pad 7's 6.19 became 6.18, pad 9's 6.96 became 6.99 (`split` reads them
  from the Set).
- `fxlab.py check`: 10 of 10 pass, pitch worst 1.25 ct (pad 8), position
  worst 0.14 ms (pad 9), bands worst 0.08 dB (pad 6); pad 10 repeats
  pad 2 exactly. `fxlab.py refs .claude/recordings/set33/pitch --seed
  1113` saved them as `tests/move_refs/pitch_env/`, which `test.sh`
  checks.
- Preview on the Move (2026-11-13, `.claude/recordings/preview2/`):
  LiveChopper plays one sample, so three Skipback takes, one per test
  sound, Pad 1 once per Set 33 pad's settings (pad 7's Decay at 6.19 ms,
  6.18 not being reachable), plus a redo of pad 8 played at -53 % by
  mistake; the pieces were joined into one take (`joined.wav`, with take
  1b's dry hit as the level reference) and split `--like` Set 33. Against
  plugin.c's render 10 of 10 pass, and Move's pads against it 10 of 10
  (pitch worst 2.17 ct, position 1.53 ms, bands 0.46 dB). The ramp pads
  read 0.5-0.8 ms off in both (PLAN "Open").
- Device: `fxlab.py device-check` on Sets 32 and 33: 26 pads, bit for bit.
- Listening A/B (2026-11-13, `ABBBA..AB.`): a subtle onset difference on
  7 of 10 pairs, the dry pair included, Move named right on 4 of 7
  (chance); the position_ramp pairs were barely audible. All accepted, so
  the difference is the dry path's onset, not Pitch Env.

### FM (Set 34)

Fitted 2026-11-13 on Set 34 (`.claude/recordings/set34/`), dialled in by
hand: Attack 1.00 ms, Hold Inf and Decay 60 s unless shown, about 3 s
apart.

| Pad | Sound | FM |
|---|---|---|
| 1, 2 | sine_441, position_ramp | dry (Stretch 1.00) |
| 3-6 | sine, sine, ramp, ramp | Amount 100 %, 25 %, 100 %, 25 %, Freq 10 Hz |
| 7-8 | sine_441 | Amount 100 %, 25 %, Freq 1.00 kHz |
| 9 | sine_441 | Amount 50 %, Freq 100 Hz |
| 10-12 | sine, ramp, sine | Amount 100 %, Freq 10 Hz, 10 Hz, 1.00 kHz, Decay 100 ms |
| 13 | position_ramp | Amount 100 %, Freq 10 Hz, Decay 990 ms |
| 14-15 | sine, ramp | Amount 100 %, Freq 10 Hz, Hold 501 ms, Decay 100 ms |
| 16 | sine_441 | a copy of pad 3 |

- **Depth:** the read rate is 1 + Amount x 9.995 x the LFO: at 100 % the
  read runs backwards in the troughs. Fitted on the position_ramp pads'
  read position (rms 1.9 frames over 1.85 s).
- **LFO:** a parabolic sine (two parabola halves, third harmonic 1/27),
  not sinf: a sine leaves a 3rd-harmonic residual the parabola removes.
  Phase 0, rising, at note-on.
- **Decay:** the depth falls as a decay to 1 % over the global Decay +
  50 ms, counted from note-on: Hold doesn't delay it (pads 14-15 fall
  with pads 10-11).
- **Repeatable:** pad 16 is bit for bit pad 3.
- `fxlab.py check`: 15 of 16 pass. Position worst 1.04 ms (pad 5); the
  1 kHz pads match Move's waveform to -53 to -62 dB. Pad 9 fails one
  quiet 44 Hz band window, 4.45 dB against 3 (rms 0.38): a drift under
  0.1 % in the read, untraced (PLAN "Open").
- Metrics: FM that stops and reverses the read (Amount x 10 >= 1) has no
  pitch metric (a zero-crossing pitch is undefined at the stops). Below
  43 Hz (four LFO cycles a 4096-frame band window; 20 Hz until Set 36)
  its bands compare the spectrum averaged over the sound, the narrow low
  bands swinging 20 dB a window; the position_ramp pads hold its timing.

Set 36, the first acceptance Set (`accept-set FM --seed 1114 --pads 14
--spec`, the global Decay drawn too, Attack at its minimum, Hold Inf),
written with `make-set` and recorded 2026-11-14: 15 of 16. Pad 11
(sine_441, 77 %, 20.1 Hz, Decay 1.51 s) failed bands at 7.49 dB: our
read ends 3.15 frames (0.07 ms) behind Move's, gathered while the
modulation is deep (shifted by that, the waveforms agree to -32 dB),
and at 20.1 Hz, half a band window a cycle, the window levels swing on
it. The other pads match Move's waveform to 0.3-3 LSB (pad 2, 15 %,
157 Hz, drifts 0.1 frame), the position_ramp pads its read to about a
frame, and pad 16 repeats pad 2 exactly. So Set 36 became a fit Set:
FM's slow bound for the bands moved to 43 Hz (pad 11 0.12/0.35 dB, the
rest unchanged), and the drift stays open (PLAN "Open"): depth alone
doesn't remove it (the long-Decay pads want 0.1 % more, the short ones
less). Set 34 pad 9's one window is accepted (2026-11-14).

Set 37, the acceptance Set (`accept-set FM --seed 1115 --pads 14
--spec`, drawn after the change), recorded 2026-11-14: 16 of 16. Bands
worst 0.32 dB (pad 14, 64 %, 21.1 Hz, Decay 1.39 s: Set 36 pad 11's
case, its waveform 566 LSB off from the same drift), position 0.10 ms
(pad 15), pitch 0.21 ct (pad 2); the other pads match Move's waveform to
0.3-20 LSB, and pad 16 repeats pad 2 exactly. `fxlab.py refs
.claude/recordings/set37/fm --seed 1115` saved them as
`tests/move_refs/fm/`.

- Preview on the Move (2026-11-15, `.claude/recordings/preview3/`):
  Skipback takes of LiveChopper playing Set 37's pads, one sound a take
  (take 1 kept only its last five hits, so take 1b redid the dry hit
  and hits 2-3), joined into one take (`joined.wav`) and split `--like`
  Set 37. Knob 5 has no fine step (Shift makes it Length), so Set 37's
  whole-click Decays can't be dialled: from 60.0 s its clicks sit 2
  units off them. Two readouts ("20 %", "26 %") sit on two click
  positions, and pad 11's 0.003 % can only be played as 0. What was
  played was fitted from the audio against renders (`played.json`).
  Since then `accept-set` draws only readouts that name one knob
  position once the knob has been turned to its bottom end (PLAN "When
  an effect is done", "Held out").
  Against plugin.c's render at those values 16 of 16 pass, 13 of them
  0.00 dB (worst drum_synth's first hit, bands 0.35/1.47 dB, untraced);
  Move's pads against the preview 16 of 16 (worst pad 14, 0.83/2.69 dB,
  played at Decay 1.25 s for 1.39 s).
- Device: `fxlab.py device-check` on Sets 37, 35 and 34: 48 pads, bit
  for bit.
- Listening A/B (2026-11-15, `................`): no difference heard on
  any of the 16 pairs.

### Ring Mod (Set 38)

Fitted 2026-11-15 on Set 38 (`tools/fxlab/sets/set38_ring_fit.json`,
written with `make-set`, take and Move's saved Song.abl in
`.claude/recordings/set38/`, split in `set38/ring/`): Attack 0.10 ms, Hold
Inf and Decay 60 s unless shown, 3 s apart.

| Pad | Sound | Ring Mod |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00) |
| 2-4 | sine_441 | Amount 100 %, 50 %, 25 %, Freq 5 Hz |
| 5-6 | sine_441 | Amount 100 %, 50 %, Freq 1 kHz |
| 7 | position_ramp | Amount 50 %, Freq 1 Hz |
| 8 | position_ramp | Amount 100 %, Freq 1 kHz |
| 9 | sine_441 | Amount 100 %, Freq 5 kHz |
| 10 | sine_441 | Amount 100 %, Freq 1 kHz, Decay 100 ms |
| 11-13 | position_ramp | Amount 100 %, Freq 5 Hz, Decay 100 ms, 10 ms, 1 s |
| 14 | sine_441 | Amount 50 %, Freq 5 Hz, Decay 300 ms |
| 15 | position_ramp | Amount 100 %, Freq 5 Hz, Hold 500 ms, Decay 100 ms |
| 16 | sine_441 | a copy of pad 2 |

The position_ramp pads, divided by their dry render (level 0.84649),
give the multiplier frame by frame. It is never negative: not a ring
modulator in the textbook sense.

- **Multiplier:** (1 + b/4) x (1 - b x depth x |c|), b = Amount², c FM's
  parabolic sine at Freq, phase 0 at note-on. So it peaks where c
  crosses 0 (twice a cycle: pad 8 at 1 kHz repeats every 22.05 frames),
  and at 100 % it dips to 0 at c's peaks. Fitted: makeup 0.2500 (pads
  7, 8, 11-13 each), rms 0.0003 against the measured multiplier (0.004 on
  pad 8 at 1 kHz). Amount²: pad 7's dips reach 1 - 0.25, and pad 4's 25 %
  matches with b = 1/16.
- **Decay:** depth = 10^(-1.5 t / (Decay + 50 ms)), i.e. -30 dB at FM's
  Decay + 50 ms (FM falls 40 dB there). Fitted time constants against
  (4/3)(Decay + 50 ms): 0.0800/0.080 s at 10 ms, 0.1999/0.200 at 100 ms,
  1.399/1.400 at 1 s; at 60 s the 2 s sound fits 79 s against 80
  (barely constrained). The decayed sound stays at 1 + b/4 (pad 11
  settles at exactly 1.25 x dry).
- **Hold doesn't delay it:** pad 15 fits Decay + 50 ms = 0.1499 s, once
  the envelope's rise under a finite Hold (below, "Volume envelope") is
  factored out.
- **Repeatable:** pad 16 gives exactly pad 2's numbers.
- Sine pads against the model: waveform residuals 6-27 LSB rms (-54 to
  -60 dB); pad 9 at 5 kHz 111 LSB (-42 dB), untraced (aliasing of |c|'s
  harmonics, or Move's oscillator).
- `fxlab.py check`: 15 of 16 pass, bands worst 0.11 dB but pad 7 (0.87
  dB max). Pad 15 fails bands (0.90/5.44 dB) on the envelope's rise
  under Hold, which LiveChopper doesn't model; not Ring Mod.

Set 39, the acceptance Set (`accept-set "Ring Mod" --seed 1116 --pads 14
--spec`, the first drawn at dialable positions only), recorded
2026-11-15: 16 of 16, bands worst 0.02 dB; every pad's waveform within
0.4-12.8 LSB rms of Move's (the dry pad 5.0), pad 16 bit for bit pad 2.
`fxlab.py refs .claude/recordings/set39/ring --seed 1116` saved them as
`tests/move_refs/ring_mod/`.

- Preview on the Move (2026-11-15, `.claude/recordings/preview4/`):
  two Skipback takes of LiveChopper playing Set 39's pads, sine then
  drum_synth, joined (`joined.wav`, 3 s from 0.5 s before each onset)
  and split `--like` Set 39. In take 1, Knob 5 touched its top end on
  hit 4 and Knob 7 after hit 5, so hits 4-9 played 2 units off the
  drawn values (Decay 33.3 s for 33.9 s, ...): fitted from the audio
  (`played.json`, each 0.3-0.5 LSB). Take 2, each knob spun to its
  bottom end before every value, played all seven exactly. Against
  plugin.c's render at what was played 16 of 16 (within 0.01 dB);
  Move's pads against the preview 16 of 16 (worst pad 16, 0.17/0.38 dB,
  Decay 2.45 s for 2.50 s).
- Device: `fxlab.py device-check` on Sets 39 and 38: 46 pads, bit for
  bit.
- Listening A/B (2026-11-15, `................`): no difference heard on
  any of the 16 pairs.

### Sub Osc and Noise (Sets 40, 41)

Set 40 (`tools/fxlab/sets/set40_subnoise_fit.json`, recorded 2026-11-15,
`.claude/recordings/set40/`) couldn't be split: Sub Osc outlived its
sample at Decay 60 s, so its pads piled up and clipped the capture from
pad 4 on. Pad 2 and the Noise pads still showed the shape of both, and
Set 41 (`set41_subnoise_fit.json`, `.claude/recordings/set41/`, split in
`set41/subnoise/`) was drawn from that: every Sub Osc Decay at 1 s or
less, Noise on sine_441_quiet. Attack 0.10 ms, Hold Inf and Decay 60 s
unless shown, 3 s apart.

| Pad | Sound | Setting |
|---|---|---|
| 1 | sine_441 | dry (Stretch 1.00) |
| 2-4 | silence_click | Sub Osc 100 %, 50 %, 25 %, 60 Hz, Decay 1 s |
| 5 | silence_click | Sub Osc 100 %, 30 Hz, Decay 1 s |
| 6, 7 | silence_click | Sub Osc 100 %, 60 Hz, Decay 100 ms, 300 ms |
| 8 | silence_click | Sub Osc 100 %, 60 Hz, Hold 1 ms, Decay 1 s |
| 9 | sine_441_quiet | Sub Osc 100 %, 60 Hz, Attack 100 ms, Decay 1 s |
| 10, 11 | sine_441_quiet | Noise 100 %, 50 %, Color 1 kHz |
| 12, 13 | sine_441_quiet | Noise 100 %, Color 180 Hz, 15 kHz |
| 14 | sine_441_quiet | Noise 100 %, 1 kHz, Decay 300 ms |
| 15 | drum_synth | Noise 50 %, 1 kHz |
| 16 | sine_441_quiet | a copy of pad 10 |

**Sub Osc** is a tone of its own, added to the sound, on its own envelope:

- **Model**, 2.0-6.0 LSB rms on every pad from frame 150 on: A x 10^(-3.5
  (1 - Amount)) x exp(-2π t / Decay) x sin(ω_d t), through a first-order
  high-pass at 11.0 Hz (bilinear). A = 27265 (0.832 of full scale); t from
  half a frame before the first frame out.
- **Amount** is linear in dB, -70 dB at 0: 50 % -35.0 dB, 25 % -52.5 dB.
  Whether 0 is silent or -70 dB isn't measured.
- **Decay:** τ = Decay / 2π exactly (fitted Decay/τ 6.2811-6.2832 at
  100 ms, 300 ms and 1 s; Set 40's 60 s pad 6.32 on a 3 s fit), from
  note-on. Hold, Attack and the volume envelope don't touch it: pad 8
  (Hold 1 ms, the volume envelope over at 1.001 s) is pad 2 sample for
  sample after the click, past 1.001 s too; pad 9's 100 ms Attack ramps
  its sine (dry level 0.93 there) but not the sub (A 27270). So the voice
  sounds as long as the sub does, long past the sample: at Decay 60 s,
  -0.92 dB a second for over a minute.
- **High-pass:** the onset phase leads 11.7° at 60 Hz and 22.6° at 30
  Hz, a first-order 11 Hz high-pass's (fitted 10.99-11.00 Hz on every
  pad; second order fits 2-10 x worse). Not in the dry path, which passes
  position_ramp unbent.
- **Frequency:** within 0.04 Hz of a damped resonator's, √(ω² - (2π /
  Decay)²): 59.20 Hz at Decay 100 ms (59.16 predicted), 59.95 at 300 ms,
  60.02 at 1 s; Set 40's 60 s pad 59.999. Its amplitude follows the
  resonator's too, ω / ω_d (pad 6 fitted 1.0139 x the others, ω / ω_d
  = 1.0142; pad 7 1.0013, 1.0016): Move's tone is a resonator's impulse
  response, ω e^(-αt) sin(ω_d t) / ω_d, α = 2π / Decay. plugin.c takes
  that past critical damping too (α > ω: ω e^(-αt) sinh(βt) / β), where
  no fit pad was.
- At 100 % it peaks at -1.6 dBFS alone, so with a loud sample it clips;
  Move's capture soft-clips it above 29204 (PLAN "When an effect is
  done").

**Noise** is noise added to the sound (its dry level stays 0.845), scaled
by the sound's level:

- **Follows the level:** on silence_click, nothing past the click; on
  drum_synth, the noise over the source's level stays at 0.053 (10 ms
  windows) while the drum falls 30 dB. It reaches full level within 2-4
  ms of the onset and stops with the sample; its spectrum has no copies
  at the 441 Hz sine's 882 Hz, so it isn't |x| sample by sample. The
  follower's attack and release aren't measured.
- **Color:** white noise through (1 + z⁻¹)²/4 and a bilinear band-pass
  at Color, Q 1.25, one gain for every Color: 0.34-0.48 dB rms on the
  1/6-octave band powers at 180 Hz, 1 kHz and 15 kHz (pad 12's 20 kHz
  band, 68 dB under its peak, misses by 5.5 dB). At 15 kHz the peak lands
  near 11-13 kHz, 13 dB down. Level: 2.45 x the sine's peak, per unit
  white noise (2.31-2.49 across the three Colors).
- **Amount:** 50 % is -21.5 dB under 100 %, a different law from Sub
  Osc's; one point.
- **Decay:** exp(-t / τ), -57.1 dB/s at Decay 300 ms under Hold Inf: τ =
  0.152 s, (Decay + 50 ms) / ln 10, i.e. -20 dB at Decay + 50 ms, as FM's
  modulation falls 40 dB and Ring Mod's 30 dB there (or Decay / 2 = 0.150
  s; one point).
- **Random:** pad 16's noise doesn't correlate with pad 10's (0.08), and
  its level matches (491 against 489 rms).

Set 42 (`set42_noise_fit.json`, `.claude/recordings/set42/`, split in
`set42/noise/`) followed up, on sine_441_quiet at Color 1 kHz unless
shown: Noise 25, 75 and 0 % (pad 16 repeats 25 %), Decay 100 ms and 1 s,
Hold 100 ms with Decay 300 ms, Attack 300 ms, click_train at 25 %,
position_ramp at 50 %, Color 3 kHz and 8 kHz, Sub Osc at 0 %, and a Gate
pad of each released at 0.3 s.

- **Amount 0 is off** for both (pads 4 and 13 within 0.8 LSB of the
  sound alone).
- **Noise's Amount:** 25 % -36.5 dB (pads 2 and 16: 7.10 and 6.90 rms),
  50 % -21.5, 75 % -10.7 under 100 %. Neither a power of Amount nor
  linear in dB; Amount^1.25 x 10^(-28.5 (1 - Amount) / 20) fits within
  0.4 dB (Amount x 10^(-32.2 (1 - Amount) / 20) within 0.6). Set 45
  replaced it (below).
- **Noise's Decay:** depth 10^(-t / (Decay + 50 ms)), from note-on:
  (Decay + 50 ms) / τ = 2.311, 2.289, 2.306 at 100 ms, 300 ms, 1 s, i.e.
  ln 10 (FM's is 2 ln 10, Ring Mod's 1.5 ln 10).
- **It follows the level after the volume envelope:** under Attack 300
  ms the noise ramps up with the sine; after Hold 100 ms, or a Gate
  pad's note-off, it falls with the sine's release (plus its own decay).
- **Its follower** is a smoothed |x|, not a peak: on position_ramp the
  noise over |x| stays 0.05-0.06 down to the zero crossing, which leaves
  a floor of ~13 rms (a ~17 ms lag); a sine's noise over its peak (0.53
  at 100 %) sits at its rms over the ramp's ratio (0.71 x the peak, so
  an rms or mean-|x| follower). A one-frame click (24300) leaves only ~2
  rms of noise at 25 %, ~0.7 % of the click's level: the attack is
  slow, ~3.5 ms (yet a sine's noise is at full level within ~4-6 ms). It
  then falls about 17 dB, linearly in dB (τ ~38 ms), and cuts to 0 at
  ~2300 frames. Neither a one- nor a two-pole smoother fits that tail
  (2.2-2.6 rms in log power): an attack/release follower with a gate is
  the guess, to settle against drum_synth.
- **Color** holds out of sample: Colors 3 kHz and 8 kHz against the
  model fitted on Set 41 are within 0.5 dB from 630 Hz to 10 kHz, 1-1.7
  dB low at 12.7-16 kHz.
- **A Gate Sub Osc pad** (Decay 1 s, released at 0.3 s) is the Trigger
  pad's sub exactly until the note-off; then its phase jumps ~52° and
  its level x1.36, decaying at the same rate: as if a second tone at the
  current level, ~99° apart, joined at the release. Unexplained; the
  Trigger model ignores it.
- **A Gate Noise pad** (Decay 300 ms, released at 0.3 s) holds its noise
  level while held (-2 to +1 dB over 0-0.3 s), then falls 0.32 dB/ms: the
  volume release's 0.28 and its own 20 dB over Decay + 50 ms, from the
  note-off.
- **Under a finite Hold** (pad 7, 100 ms) Move's noise sits flat at about
  -3 dB through the Hold, between the decay from the note-on (ours ~1.3
  dB low over the first 186 ms) and no decay until the Hold ends (~3 dB
  high). Hold Inf decays from the note-on (Set 41 pad 14). Untraced.

Built in plugin.c 2026-11-15 (SPEC "Effect"): Sub Osc as fitted, its tone
in a slot of its own that sounds on after the voice (a new note or "stop"
fades it out over DECLICK_FRAMES); Noise as fitted, the follower attack
3.5 ms and release 6 ms (a sine at 0.706 of its peak, Move's 0.716), its
decay from the note-on or a Gate pad's note-off, the gain set 0.45 dB
above the first estimate on Set 41's bands (Move's 100 % level measured
468 or 489 rms by two methods). `fxlab.py check` compares a Noise pad's
band power averaged over 16 windows (`noise_pad`): over 8, Move's own two
takes of Set 41 pad 10 differ by 0.95/3.52 dB.

- Set 41: Sub Osc 8 of 8 pass (bands within 0.07 dB, pad 9 0.58/0.86);
  Noise 4 of 7, pads 10, 12 and 16 over by max only (3.75-3.86 dB, low
  bands 20-38 dB down, where Move's own repeat reaches 2.97).
- Set 42: Noise passes the Amount, Decay and Color pads; fails pad 7
  (finite Hold, 2.26/6.82), pad 8 (Attack 300 ms, 1.24/4.31: one dry
  reference at 0.1 ms for a pad at 300 ms), pad 10 (position_ramp,
  1.56/4.10: the follower) and pad 15 (Gate, 2.08/8.71). Pad 13 (Sub Osc
  0 %) fails on the dry click's ring alone, pad 14 on the Gate jump.

Acceptance, 2026-11-15:

- **Sub Osc accepted on Set 43** (seed 1117), 16 of 16, refs in
  `tests/move_refs/sub_osc/`. Half its pads are overdamped, none fitted;
  the click pads (the tone alone) have no bands metric, so checked by
  hand: after a low-pass dropping the dry click's Nyquist ring (Move's,
  not ours: "Move's dry path"), gain 0.995-1.003 and 0.3-3 LSB rms.
- **Set 44** (Noise, seed 1118) passed check 16 of 16, but measured by
  hand plugin.c's noise was 4.5 dB loud at 16 % (pads 2, 16) and ~3 dB at
  20 % (pad 6): bands can't see noise ~45 dB under the sound. Not
  accepted; it led to Set 45 and the noise metric, so the next acceptance
  Set is a fresh draw, Set 46 (seed 1119).
- **Set 45** (`set45_noise_amount.json`, `.claude/recordings/set45/`):
  Noise on sine_441 at 1 kHz, Amounts 1-40 %, each pad less Move's own
  dry pad 1 (exact: the same sound, so no dry-path error). Amount's gain
  is linear in dB in two pieces: -70 dB just above 0 to -30 dB at 30 %
  (1.33 dB a %), then to 0 dB at 100 % (0.43 dB a %): 1 % -68.4 (line
  -68.7), 5 % -63.3 (-63.3), 10 % -56.4 (-56.7), 20 % -43.2 (-43.3), 30 %
  -29.8 (-30.0), 40 % -25.5 (-25.7), and Set 42's 50 % -21.5 (-21.4), 75 %
  -10.7 (-10.7). The spectrum's shape doesn't change with Amount (its
  30 % and 40 % pads failed bands on level alone). In plugin.c: Set 45 now
  sits 0.25 ± 0.08 dB under Move at every Amount, Set 44's pads within
  -0.14 to +0.51 dB; the gain is left as it is (Set 44's 62-82 % pads,
  within 0.2 dB, would go high).
- **check's noise metric** (`curve_noise`): on Noise pads, each 186 ms
  block from 5 ms of the piece once plugin.c's dry render and its
  derivative are fitted out, in dB, Move's against ours, limits 1/3 dB.
  The fit takes out Move's dry path, which runs a fraction of a frame off
  ours (5.9 rms on sine_441, 0.36 after); levels are floored at 1 LSB or
  50 dB under the dry block (drum_synth's transient leaves ~2e-3).
  Against Set 44 it fails the old Amount law (pads 2, 16: 4.2/4.6 dB) and
  passes the new. Noise pads now line up on the dry render: loud noise
  threw the match against ours (Set 44 pad 8 at lag -19, Set 42 pads 5
  and 15 too; pad 5's bands, aligned, are 0.96/3.18). Set 42 pad 9
  (click_train) fails it by 33 dB on the dry clicks' Nyquist ring. The
  floor was 50 dB under the dry block at first; Set 46 showed that hid
  its 13-23 % pads, and drum_synth's transient, fitted out, sits ~66 dB
  under, so it is 60 (stricter: Sets 44 and 46 pass it).
- **Noise accepted on Set 46** (seed 1119, a fresh draw), 16 of 16 with
  one waiver, refs in `tests/move_refs/noise/`. Noise measured on pads 3-8,
  13 and 15 (0.06-0.87 dB rms), among them 13.8 % (pad 6) and 16 % on
  drum_synth (pad 15): the refitted low range, held out. The others'
  noise (1.5-12 %, or Decays of a few ms) sits under the floor. Pad 3
  (drum_synth, 77 %, Color 202 Hz, Decay 218 ms) fails bands 1.62/5.90
  with its noise level matching (0.19/0.32): drum and noise are equally
  loud near 160 Hz, so one take's band power swings with their random
  phase. Rendered under 10 other seeds, plugin.c against itself differs
  by up to 1.67/5.44 (median 1.21/3.21); Move against the 10-seed mean
  is 1.03/3.57, a seed against the other nine's 0.44-1.17/1.12-3.27.
  Waived (`refs --waive 03_drum_synth:bands`): the ref keeps pad 3's
  noise curve and says the bands one was left out.
- **Previews and A/B, 2026-11-16** (`.claude/recordings/preview5/`,
  five Skipback takes of Sets 43 and 46's pads, played in chop mode from
  the readouts). Against the renders: Sub Osc bit-exact after the onset
  (frames 0-7: the preview's Attack minimum plays as 0), Noise 16 of 16
  on the noise metric. Three knobs landed one or two units off the grid
  with the right readout (`played.json`); rendered at them, bit-exact.
  Against Move: Sub Osc 16 of 16, Noise 14 of 16: pad 3's bands (the
  waived pad) and pad 7's noise, 1.16/2.59 (the render: 0.87/1.93; 10
  seeds 0.17-1.16). Pad 7 (22.9 %, Color 181 Hz, Decay 9.7 ms) has noise
  only in its first block, right at the 60 dB floor; Move's dry path
  leaves a residual on drum_synth's transient (frames 0-384, the same on
  pads 9 and 11, whose noise is gone) that lifts Move's block over the
  floor, and the preview's noise falls under it. From 17 ms Move's tail
  matches the seeds' mean. A metric edge, not Noise; the metric stays as
  accepted. `device-check` bit-exact. Listening A/B: no difference heard
  on any of the 32 pairs, the silence_click pairs' full onset click
  included.

### Volume envelope (Set 35)

The first Set written by `fxlab.py make-set`
(`tools/fxlab/sets/set35_envelope.json`), recorded 2026-11-14: every pad
sine_441, Stretch 1.00, Attack 1.00 ms, 3 s apart, played by the Set's
clip, which let go of the Gate pads at 0.5 s. Move opened the generated
Set and played its clip; it saved the Set back with the same pad values.

| Pad | Mode | Hold | Decay |
|---|---|---|---|
| 1 | Trigger | Inf | 60 s |
| 2-9 | Trigger | 100 ms | 10 ms, 30 ms, 100 ms, 300 ms, 1 s, 3 s, 10 s, 60 s |
| 10 | Trigger | 500 ms | 100 ms |
| 11 | Trigger | 1 ms | 100 ms |
| 12-14 | Gate, let go at 0.5 s | - | 100 ms, 1 s, 10 ms |
| 15 | Trigger, Attack 0.10 ms | 100 ms | 100 ms |
| 16 | Trigger | 100 ms | 100 ms (a copy of pad 4) |

- **Decay:** a straight line in dB, -84.0 dB at the Decay time (fits of
  -83.98 to -84.33 dB over Decays 30 ms to 10 s, residuals 0.01 dB rms),
  starting at Attack + Hold within 5 frames, then silence (-84 dB of
  this level is under 1 LSB). Hold 1 ms and 500 ms give the same curve.
  LiveChopper's was linear in amplitude: 12-18 dB off mid-Decay.
- **Gate release:** the same curve from the note-off (within 5 frames),
  from full level; held, the level stays at 0 dB.
- **Attack:** linear in amplitude from 0 on the note-on frame, as ours.
  Pad 15's 0.1 ms Attack sits up to 0.8 dB under the 1 ms pads for its
  first ~60 frames, 0.09 dB on average up to the Decay: within limits.
  Traced on Set 38 (2026-11-15): under a finite Hold the level climbs
  linearly over the Hold, from the Attack's dry level to about 0.933
  (Set 35 pad 15: 0.849 at 2 ms to 0.930 at 95 ms of its 100 ms Hold;
  Set 38 pad 15, Ring Mod: x1.103 of 0.8465 by its 500 ms Hold's end).
  With Hold Inf it stays at the Attack's level (0.8465 at 0.1 ms); at
  Attack 1 ms, 0.9311, it climbs only 0.2 %. LiveChopper doesn't model
  it (PLAN "Open").
- **Repeatable:** pad 16 gives exactly pad 4's numbers.
- `fxlab.py check --gain 0.93114` (the dry level from Set 34; with one
  sustaining pad the estimate from the dry pieces fails): 16 of 16 pass,
  bands worst 0.42 dB (pad 15), the rest 0.04 dB. Saved with `refs
  --name envelope` as `tests/move_refs/envelope/`.
- `fx_render` lets go of a Gate pad on the clip's frame, splitting the
  block; on the Move, Schwung hands LiveChopper MIDI a block at a time,
  up to 128 frames (2.9 ms) late.

### Following Transpose (Set 47)

Fit Set `tools/fxlab/sets/set47_transpose_fit.json`, recorded
2026-11-16, 5 s apart (-12 st doubles a 2 s sound). r is the pitch
ratio, 2^((Transpose x 100 + Detune in cents) / 1200).

| Pad | Sound | Settings |
|---|---|---|
| 1 | sine_441 | dry |
| 2, 3, 4 | sine_441 | +12, -12, +7 st; Attack 100 ms, Hold 200 ms, Decay 200 ms |
| 5 | sine_441 | Detune +50 ct; Attack, Hold, Decay 500 ms |
| 6 | sine_441 | pad 2 with Voice_PitchToEnvelopeModulation false |
| 7 | sine_441 | +12, Gate let go at 0.5 s, Decay (release) 200 ms |
| 8 | position_ramp | +12, dry |
| 9, 10 | position_ramp | +12, -12; FM 25 %, 10 Hz, Decay 300 ms |
| 11 | position_ramp | +12; Ring Mod 50 %, 20 Hz, Decay 300 ms |
| 12, 13 | silence_click | +12, -12; Sub Osc 100 %, 60 Hz, Decay 300 ms |
| 14, 15 | sine_441_quiet | +12, -12; Noise 100 %, Color 1 kHz, Decay 300 ms |
| 16 | sine_441 | a copy of pad 2 |

Hold Inf and Attack at its minimum unless shown.

- **Envelope:** Attack, Hold and Decay each take their time / r: the 50 %
  point of the rise, the end of the hold and the -42 dB point land
  within 3-6 ms of that on pads 2-5 (+12: 25/147/200 ms for 25/150/200),
  Detune included (pad 5: 966 ms against 972 following and 1000 fixed).
  With Voice_PitchToEnvelopeModulation false (pad 6) they keep their
  times, so that is Live's "Envelope Follows Pitch". LiveChopper always
  follows, and exports the flag on.
- **Gate release:** doesn't follow (pad 7: -21 dB at 51 ms and -42 dB at
  101 ms after the note-off at +12, the 200 ms curve).
- **Effect frequencies follow, their decays don't:** with Freq or Color x
  r and the Decay as set, Ring Mod, Sub Osc and both Noise pads pass;
  scaling their decays by 1/r as well fails them all (Sub Osc bands
  7-11 dB, Noise 9-15 dB on the noise metric). So the effects' decays
  use the knob's Decay even though the volume envelope's Decay follows.
- **FM's swing isn't scaled:** the read rate is r + Amount x 10 x depth
  x sine, not r x (1 + ...). Fitted on the read position with free
  Freq, depth and decay: pad 9 (+12) 20.0 Hz and 1.246 (2.5 / 2), pad 10
  (-12) 4.98 Hz and 4.96 (2.5 x 2), both spans 349 ms (Decay + 50 ms).
  The 10 Hz floor of FM's Freq applies before the x r (pad 10 plays
  5 Hz).
- Pad 8 and the Transpose pads of Sets 31 and 32 need nothing more: the
  read is 2.002x at +12 within the level estimate, and Set 32 pad 15 (1 ms
  Attack at +12) passes once the Attack follows.
- `fxlab.py check` with the model: 15 of 16 pass, FM positions 0.58 ms;
  pad 6 fails bands (2.07/3.89 dB) because LiveChopper has no setting
  for the flag. The finite-Hold and Gate pads read 0.86 dB over our
  render: Move's level under a finite Hold ("Volume envelope"), not
  Transpose. Set 31 passes 12 of 12, Set 32 16 of 16.
- Untested: Attack on a Gate pad (we follow, as on Trigger pads), Sub
  Osc's 11 Hz high-pass, 8-Bit's rate, Stretch and Loop (their own Sets),
  and Transpose turned during a note (we follow it live).

Accepted on Set 48 (`fxlab.py accept-set Transpose --seed 1120`,
`tools/fxlab/sets/set48_transpose_accept.json`), recorded 2026-11-16:
4 pads with no effect (2 of them Gate), 2 each of Punch, Pitch Env, FM
and Ring Mod, 1 Sub Osc and 1 Noise, at Transpose -23 to +17 st, Detune
on 9 of the 14 drawn pads, Attack 1-231 ms, Hold 1 ms to Inf, Decay 3 ms
to 1 s; every Attack 1 ms or more, pad 1's too, so Move's level is 0.93
on every pad. `check`: 13 of 16, the 3 others waived in `refs --waive`:

- **Pad 3** (no effect, -17 st, Attack 24.6 ms, Hold 3.5 ms, Decay 79 ms)
  position 1.70/3.99 ms: the waveform is within -44 to -49 dB of Move's,
  Move 0.031 dB louder (its level under a finite Hold, "Volume
  envelope"), and after that one gain the read matches to 0.21/0.63 ms.
  The position metric read the ramp's value as the read position, so it
  took level for position (since fixed, below: 0.33/0.83 ms).
- **Pad 9** (Pitch Env 82 %, +7 st, Attack 1.24 ms, Decay 650 ms)
  position 0.91/8.41 ms: values within ~0.5 % of Move's for the whole
  sound; the error sits in the 0.8 ms Attack and the decay, where the
  falling level reads as a move toward the ramp's middle (since fixed,
  below: 0.14/0.30 ms).
- **Pad 15** (Noise 95 %, 326 Hz, on drum_synth, +12 st 20 ct) bands
  1.16/3.60 with the noise metric passing (0.46/0.80): plugin.c against
  itself over 10 seeds gives bands 0.69-1.22 / 1.48-3.93, 4 of 10
  failing, so one take can't resolve this pad's bands (as Set 46 pad 3).

The position metric under an envelope (2026-11-17, PLAN step 2b): on a
position_ramp near -16000, 0.3 % of level reads as 3 ms, and Move's level
on these pads sat 0.2-0.3 % off the take's dry level. `check` now (a) fits
each pad's level against ours for this metric alone (`position_level`),
(b) divides both by the pad's envelope, plugin.c's render of a constant
through the same settings (`env_*` pieces), so a read error under a decay
counts at full size, reading only where the envelope is over 0.25, and
(c) leaves out a finite Hold after an Attack under 1 ms in output time,
where Move's level climbs and ours doesn't (pad 9's 0.8 ms Hold at +7: 2 %
over 35 frames). Pads 3 and 9 then pass (0.33/0.83 and 0.14/0.30 ms), so
their waivers were dropped and the transpose, pitch_env and fm position
refs re-scored. Every other Set's position pads score the same or better
(Set 47 pads 8-10, finite Holds: 0.58/1.02 to 0.02/0.10).

Two `split` fixes came from this Set: a pad under the onset level is
placed by the clip's note time (pad 14: Attack 24.6 ms over the click, a
-50 dBFS Sub Osc), and a piece starts where its sound begins, not where
it crosses the onset level (pad 6 crossed it 145 frames in, past
`align`'s 64; pads 7 and 10 also moved and improved). Sets 39, 43 and 46
split as before. Refs in `tests/move_refs/transpose/`.

Preview (2026-11-16): Set 48's 16 pads played in LiveChopper in 5
Skipback takes, joined in pad order. Against the render at the values
played (Attack 1.03 ms for 1.00 ms, which the knob can't reach; the Gate
holds fitted from the audio) all 16 match, most bit for bit. Against Move:
the 3 waived pads as above and pad 4, held 0.345 s by hand against the
clip's 0.40 s. `device-check` on Sets 47 and 48: 38 pads bit for bit.
Listening A/B: no difference heard on any of 16 pairs.

### 8-Bit (Set 49)

Set 49 (`tools/fxlab/sets/set49_8bit_fit.json`), recorded 2026-11-16,
the first Set with 8-Bit pads: Rate 1 kHz, 14.08 kHz (Move's default) and
30 kHz on sine_441_quiet, position_ramp, click_train, sweep and
noise_white; Decay Off, 1 s, 100 ms and 10 ms on noise_white at 30 kHz;
a ramp under a volume Decay; click_train and noise_white at +12 st; pad 16
repeats pad 2. Take and split in `.claude/recordings/set49/`. Move's 8-Bit
is three stages, in this order:

- **The hold.** The sound is sampled at instants k x 44100 / (Rate x the
  pitch ratio) frames from the note-on, at the Rate as stored, not
  rounded to a whole Hz (Set 50: rounding, an error of 1e-5 to 1e-4,
  failed its sweeps at 1.5 and 2.6 kHz by 1.8-2.9 dB; exact, 0.04-0.06),
  so the hold follows Transpose (a
  1 kHz hold is 45 frames, 23 at +12), and held from the frame after each
  instant (Set 49 pad 6: a click on an instant at 14.08 kHz holds 3
  frames, not 4), the note-on's at once. The value held is the sound read
  between frames at the instant: linearly, which fits the 1 kHz sweep's
  holds better than the nearest frame, the frame before or a cubic. No
  low-pass before it: the held levels reach the source's on the sweeps up
  to 18 kHz at every Rate.
- **The cut: 8 bits of A-law**, A = 87.6, the continuous law (not G.711's
  segments): the code is 128 (1 + ln A|x|) / (1 + ln A) of full scale,
  128 A|x| / (1 + ln A) under 1/A, truncated toward zero, and the value is
  the code's. On the ramp (pad 3) every level sits on a whole code to
  0.018 code rms (after Move's 0.8465), truncation predicts 99.8 % of its
  frames (rounding 50 %), each step is 0.958140 of the one above (16.2 a
  doubling) and near 0 the steps are 16 LSB. It is cut before the volume
  envelope (pad 4 over pad 3 is a smooth decay, 5e-5 a frame) and before
  Move's 0.8465. Truncation costs about 0.2 dB of level. Pads 2 and 16
  score the same against the render: no dither.
- **A low-pass**: a two-pole TPT low-pass with k = 2.18 (two real poles,
  a little past Q 0.5; a zero pair at Nyquist) at 20 kHz with Decay Off:
  on pad 6's clicks (no drift at 14.08 kHz) 3.1 LSB rms, against 7.9 at
  k = 2 and 19.75 kHz, the first fit (on pad 5, where the drift blurs
  it). A Decay closes it: cutoff = 300 Hz + (20000 - 300) e^(-ln 1000 t /
  Decay), from the note-on in output time, so it doesn't follow
  Transpose (pad 15 traces pad 12's cutoffs). At the 300 Hz floor, pad
  13 over pad 10 fits k = 2.15-2.2 to 0.045 dB rms from 80 Hz to 2.5 kHz
  (k = 2 is 0.3-0.7 dB light near the cutoff: -10.0 dB at 441 Hz against
  Move's -10.7, which Set 50's quiet sines showed as 0.6 dB). Spectral fits per window, pad 11 (1 s): 17.8 kHz at
  12 ms, 9.9 kHz at 0.1 s, 2.7 kHz at 0.3 s, 915 Hz at 0.5 s, 317 Hz at
  1 s; pad 12 (100 ms) the same over a tenth of the time; pad 13 (10 ms)
  at 300 Hz within 17 ms. A hard floor (an exponential to 30 Hz held at
  300 Hz) left our render 7 dB too dark at 0.5-0.8 s of pad 11.

Open: **the hold's period drifts** off 44100 / Rate on Move. Fitted on the
sweeps, the instants come early by 5.9e-6 of the period at 1 kHz and
7.0e-6 at 30 kHz, by 2.95e-6 at 1 kHz +12 st, and not at all at 14.08 kHz
(pad 6's 19 clicks are identical). On pad 5 it walks each click's instant
0.026 frames earlier a click, and with the linear read each held click
falls a code or so: codes 124, 124, 123 ... 108 over 19 clicks (-6 dB),
predicted to a code. A float32 phase, a float32 read position or float32
seconds don't produce it; the cause is untraced, and LiveChopper holds at
the nominal period.

`check` with the model: pads 2, 3, 6, 8 and 16 pass (bands 0.06-0.39
rms), pad 4 too at 0.83 (Move's level under a finite Hold, "Volume
envelope"). Pads 5 and 14 fail on the drift (3.18 and 1.44 rms). The
sweeps at 1 kHz and 30 kHz and the noise pads fail bands' per-window cells
(max 12-27 dB) where the cell holds only aliasing and quantization
by-products, which turn over with any difference in timing; power-averaged
over 16 windows they are 0.47-0.77 dB rms (max 2.6 dB, in the narrow
bands under 130 Hz), the sweep at 14.08 kHz 0.23. Pad 15's 7.5 dB at
20 kHz in its first second is the read at +12 on white noise (Move's
resampler, not 8-Bit).

Acceptance Set 50 (`fxlab.py accept-set 8-bit --seed 1121`,
`tools/fxlab/sets/set50_8bit_accept.json`), recorded 2026-11-17: not
accepted, and two fixes came from it (the Rate unrounded, k = 2.18 at
20 kHz, above), so it is a fit Set now. Its take has a capture glitch in
pad 1 (the dry pad): the stream jumps 128 frames at 0.14 s and the pad
sits 1413 frames off the clip's grid (pads 2-16 land on it as Set 49's
do), so `check` needs `--gain 0.84649` (Move's dry level at Attack's
minimum). With the fixes, 13 of its 15 8-Bit pads pass, most at
0.01-0.06 dB rms; pads 2 and 16 (sweep, 8.01 kHz, Decay 43.6 ms; Move's
two takes identical) fail at 1.19/5.24 in the bands under the 300 Hz
floor late in the sweep, where only the beats at multiples of the Rate
are left. Linear reading fits them best (474 LSB rms; Hermite 505, sinc
576, nearest 596); scaling the Rate by up to +-9e-6 doesn't help the
residual. Untraced; the hold's drift is the likeliest.

Accepted on Set 51 (`fxlab.py accept-set 8-bit --seed 1122`,
`tools/fxlab/sets/set51_8bit_accept.json`), recorded 2026-11-17, decided
the same day: 12 of 16 pass (the sines, ramps and drum_synth at
0.01-0.02 dB rms, the noise at 26.5 and 20.4 kHz ~0.3, the 1.87 kHz sweep
0.55), and 4 bands are waived (`refs --waive`), pending the listening A/B:

- **Pads 2 and 16** (sweep, 4.76 kHz, Decay 427 ms; Move's two takes
  identical) 1.91/10.63, and **pad 12** (sweep, 3.97 kHz, Decay 253 ms)
  1.38/6.73. Every failing cell is under 140 Hz and from 2.97 s on, with
  the low-pass at its 300 Hz floor and the sweep at 3-12 kHz: what's
  left there is the beat where the sweep passes a multiple of the Rate
  (pad 2's worst block, 3.34-3.72 s, holds its crossing of 2 x 4760 Hz),
  whose level in a narrow band depends on its phase as it turns at 0 Hz,
  so on the instants to a few microseconds (Move's drift: ~20 us by
  3.4 s, ~70 degrees at 9.5 kHz). Its errors change sign from band to
  band in one block (+10.6 dB at 22 Hz, -4.9 at 110), and plugin.c
  against itself with the Rate moved by 3e-6 to 7e-6 fails them as
  much: pad 2 1.20-2.47 / 5.9-13.6, pad 12 0.87-1.69 / 3.6-8.1 (pad 7
  0.31-0.93 / 1.7-4.1, pad 4's sine 0.00-0.02).
- **Pad 8** (noise_white, 14.9 kHz, Decay 516 ms) 0.65/3.32, its max in
  the 55 Hz band (about one FFT bin), where the noise held at 14.9 kHz
  folds its top half down; against itself at +-7e-6, 0.60-0.69 / up to
  3.12.

The take has one 128-frame jump, between pads 4 and 5, in the silence.
Refs in `tests/move_refs/8_bit/`.

Preview (2026-11-17, `.claude/recordings/preview8/`): Set 51's 16 pads
played in LiveChopper in 5 Skipback takes, one a sound, joined with take
1's dry hit first. Against the render all 16 match (0.00-0.01 dB),
against Move exactly the acceptance's result (the same 4 waived pads,
the same numbers). `device-check` on Sets 49-51: 48 pads, 44 bit for
bit, 4 within 1 LSB on 1-2 frames (the Move's `logf`/`expf`). Listening
A/B: no difference heard on any of 16 pairs, the 4 waived ones included.

Also from 8-Bit: the first build of it used `fmod`, whose symbol in the
cross toolchain's glibc is `fmod@GLIBC_2.38`; the Move has 2.35, so that
`dsp.so` wouldn't load there, with every host test passing. It uses
`floor` now, and `scripts/build.sh` refuses a `dsp.so` that needs any
glibc symbol past 2.35.
