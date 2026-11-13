# LiveChopper spec

What the module does today. Planned work is in [PLAN.md](PLAN.md) and moves
here once it's built.

A tool for Ableton Move (Schwung) that chops a sample across pads in real time
by tapping pads while it plays (the "lazy chop" / live chop workflow of Akai
MPCs, also on the SP-404MKII and EP-133 K.O. II), then exports the result as
a Move drum rack preset or one WAV per slice.

## Core: real-time chopping (primary focus)

1. User picks a WAV. It is assigned to Pad 1 with start = 0 and end = sample end.
2. The next unused pad (Pad 2) lights blue: it is the "chop target".
3. Pressing Pad 1 plays its region.
4. While audio is playing, pressing the blue pad chops at the current playhead
   position T:
   - the pad that is playing gets end = T
   - the blue pad gets start = T and end = the old end of the pad that was
     playing (for the first chop, the end of the sample)
   - the blue pad starts playing from T, so playback continues seamlessly
   - the next unused pad lights blue
5. Pads that already have a region play that region when pressed.
6. In chop mode, every pad chokes every other pad (one voice at a time).
7. Chop timing must be sample-accurate: the playhead position comes from the
   audio engine at the moment the note-on is processed, not from the UI tick.

## Also

- Transpose and detune: repitch the sample, one global setting (see Decisions).
- Fine-tune chop points afterwards with knobs/jog and a waveform view, borrowing
  from the waveform editor's marker and zoom UI.
- Export menu on the Record button, like the waveform editor's: rename,
  export a Drum Preset, export Slices (one WAV per pad), or Cancel.
- Undo the last chop or delete; Shift+Undo redoes it.
- Tools menu on Shift + jog click: Normalize audio, Channels, Back.
- help.json and screen-reader announcements (chop made, pad selected, export
  done).

## Decisions

- Pads: 16 maximum: the left 4x4 block of pads, the same 16 a Move drum rack
  uses. The right half is free for other controls. When all 16 are used, no
  pad lights blue and further chops are ignored.
- Pad order: Pad 1 is the bottom-left pad, numbered left to right, then
  upward, like a Move drum rack: Pad i (0-15) is note
  68 + 8*floor(i/4) + i%4, so Pad 1 = 68 and Pad 5 = 76. (The waveform editor
  uses two rows of 8 instead; don't copy its pad indexing.) Pads always stay
  in time order: pad N is the Nth slice of the sample. The blue pad is the
  next unused pad after the last slice. When a chop splits a slice in the middle of the list, the
  new slice is inserted directly after the slice that was playing, and every
  later slice moves up one pad. Example: with pads 1-3 chopped and Pad 4 blue,
  playing Pad 1 and pressing Pad 4 gives:
  Pad 1 = old start to T, Pad 2 = T to Pad 1's old end (the new slice),
  Pad 3 = old slice 2, Pad 4 = old slice 3, and Pad 5 lights blue.
  Playback continues on the new slice (now Pad 2), not on the pad pressed.
- Knob pages: the knobs copy the two banks of Move's own Drum Sampler (Move
  manual 15.9.1), so every control Move has sits on the same knob with the
  same Shift behaviour. Down shows the Filter & Setup page, Up the Main page
  (the button for the other page is lit); the bottom line and screen reader
  confirm. Main: 1 Transpose (Shift: Detune), 2 Start (Shift: Zoom), 3 Attack, 4 Hold, 5 Decay
  (Shift: Length), 6 Effect, 7 and 8 the effect's two settings. Filter & Setup: 1 Frequency, 2 Resonance (Peak
  Gain on Peak), 3 Type, 4 Envelope Mode, 5-7 not used (chop mode always
  chokes; no velocity), 8 Gain (Pan's slot; Move has no gain knob here).
  Unused knobs show "-". The LED under each knob is lit while turning it
  does something on this page, brighter the higher its value (the
  framework's knob_leds.mjs, as its parameter pages use: Knobs 1-4 white,
  5-8 amber, never fully dark while lit). Unused knobs, and Rate while the
  effect is off, stay dark, and every knob is dark in a menu.
  The page and the Knob 5 toggle are kept for a resume and reset on a fresh
  start. Jog, Left/Right and the buttons work
  the same on both pages.
- Knob model: every knob that mirrors a Move control steps, fine-steps and
  reads out as Move's own does (src/knobs.mjs, measured on a Move; see
  NOTES.md "Every knob follows Move"). A knob is a position on Move's grid of
  1308 units: a click is 10 (131 clicks end to end, the last one short),
  Shift a fine step of 1, and a click keeps stepping until the readout
  changes. Each setting has its own curve over its range. Positions can sit
  off the grid (Move's own defaults do), and steps keep that offset. Times
  and frequencies read in three significant figures ("0.10 ms", "110 ms",
  "1.03 s", "979 Hz", "1.20 kHz"), percentages and dB with one decimal
  below 10 and none from 10 up ("9.9 %", "10 %", "-12 dB"), and nothing
  has a "+". The knobs on it: Attack, Hold, Decay, every effect setting
  (Main Knobs 7 and 8), Frequency, Resonance and Peak Gain. Transpose and Detune step 1 a click; Start, Zoom,
  Length, Type, Mode, Effect and Gain keep their own steps.
- Shift on Main Knob 5: while Shift is held, Knob 5 is Length instead of
  Decay, as on Move, so neither has a fine step. A touched knob whose role
  changes with Shift (Knobs 1, 2 and 5) shows its new role at once.
- Transpose: repitch only (changes length and pitch together), one global
  setting (Main Knob 1, -48 to +48 semitones, Move's drum sampler range),
  shown as Move does: "12 st", "-12 st".
- Detune: fine repitch on top of transpose, one global setting (Shift +
  Main Knob 1, -50 to +50 cents, default 0, shown "5 ct"). Exported as
  Voice_Detune.
- Envelope: one global attack, hold and decay (AHD, matching the Move drum
  sampler's A-H-D mode) applied to every slice in chop mode and carried into
  the export for every pad. Main Knobs 3/4/5, on the knob model with Move's
  log curves: Attack 0.10 ms to 20.0 s, Hold 1.00 ms to Inf (until the
  slice ends), Decay 1.00 ms to 60.0 s. Default: attack at its minimum
  (played as 0, so slices sound like the raw sample), Hold Inf, Decay
  50.0 ms. A chop
  does not retrigger the envelope. This mode is for chopping; per-pad sound
  shaping is done in the drum rack after export.
- Declick: when a pad cuts off another, the old voice fades out over ~1.5 ms.
- Gain: Filter & Setup Knob 8, one global setting like Simpler's Gain, with the range of
  Move's drum sampler: -70 to +24 dB, default 0 dB. 0.5 dB steps (Shift: 0.1 dB) from -24 dB up, 2 dB
  steps below. Applied to playback (ramped over a block, so no clicks; boosts
  clip at full scale). The waveform is drawn at the gained level.
- Effect: one global setting that sets the drum sampler's playback effect
  on every pad. Main Knob 6 steps through Move's nine, one a click, in
  Move's order: Stretch (the default, at factor 1.00: what Move's own
  default exports, a no-op), Loop, Pitch Env, Punch, 8-Bit, FM, Ring Mod,
  Sub Osc, Noise. There is no Off, as on Move. Main Knobs 7 and 8 are the
  selected effect's two settings on the knob model, with Move's ranges,
  curves and defaults, and each effect keeps its own while you switch
  (labels shortened to fit the bottom line; the screen reader says Move's
  names):

  | Effect | Knob 7 | Knob 8 |
  |---|---|---|
  | Stretch | Factor, 1.00-20.00 | Grain, 5.00-300 ms |
  | Loop | Offset, 0-100 % | Loop Len, 10.0-500 ms |
  | Pitch Env | Amount, -100 to 100 % | Decay, 5.00 ms-2.00 s |
  | Punch | Amount, 0-100 % | Release, 60.0 ms-1.00 s |
  | 8-Bit | Rate, 1.00-30.0 kHz | Decay, 10.0 ms-3.98 s, then Off (default) |
  | FM | Amount, 0-100 % | Freq, 10.0 Hz-4.50 kHz |
  | Ring Mod | Amount, 0-100 % | Freq, 1.00 Hz-5.00 kHz |
  | Sub Osc | Amount, 0-100 % | Freq, 30.0-120 Hz |
  | Noise | Amount, 0-100 % | Color, 180 Hz-15.0 kHz |

  Chop mode plays a stand-in for each (Punch excepted: it follows Move's
  measured curve), before the filter
  (sample -> effect -> filter -> envelope, drumCell's order): 8-Bit samples
  and holds each voice at the rate (after repitching) and cuts it to 8
  bits, and its Decay closes a low-pass on that over the Decay time;
  Punch matches Move's gain curve (NOTES.md "Punch"): a makeup of
  1 + Amount³ that the transient keeps, with the rest ducked to
  1 - Amount of it (no lower than 0.15) and back by about the Release;
  Pitch Env bends the pitch by up to +-24 semitones at 100% (Move shows
  only a percentage), decaying over the Decay; FM wobbles the playback rate
  by up to +-1 octave at its Freq; Ring Mod multiplies by a sine; Sub Osc
  adds a sine (-6 dBFS at 100%); Noise adds noise low-passed at its Color,
  following the sound's level. Stretch moves the playhead at 1/Factor of
  the normal speed and plays two grains of Grain size from it, half a grain
  apart under Hann windows, at the normal speed, so the pitch holds while
  the slice lasts about Factor times as long (Factor 1.00 is plain
  playback); a grain that would run past the slice's end starts early
  enough to fit. Loop starts Offset of the way into the slice, as on Move,
  and repeats the part from there, Loop Len long in the sample's
  own time (at least 10 ms, clamped to the slice's end), until the envelope
  ends: with Hold at Inf, until another pad cuts it or the tool is hidden.
  Each wrap dips the level for ~1.5 ms either side against clicks; the
  knobs move the loop live, and a chop or marker nudge under a looping
  voice moves its loop with the slice. The waveform is drawn without the effect.
- Filter: one global setting that sets the drum sampler's filter on every
  pad. Type (Filter & Setup Knob 3): Low-Pass 12, Low-Pass 24 (the
  default), High-Pass 24, Peak; no Off, as on Move: Low-Pass 24 fully open
  is Move's "no filter". Frequency (Knob 1): 30 Hz to 22 kHz (default),
  log. Knob 2: Resonance, 0-90% (Move's 0-0.9), linear; on Peak it is Peak
  Gain instead, -12 to +12 dB, linear in dB, and the two are kept
  separately. All three on the knob model. Chop mode plays a stand-in after the effect (sample -> effect ->
  filter -> envelope, drumCell's order): a state-variable filter, two
  stages for the 24 dB types, a fixed-width bell for Peak (which ignores the
  resonance), with the cutoff gliding over ~10 ms. A low-pass type fully
  open is skipped, so the default plays exactly as no filter. The waveform
  is drawn unfiltered.
- Choke: all pads choke each other by default, in chop mode and in the exported
  drum rack preset (supported: every pad gets the same chokeGroup).
- Pad colors: playable slice pads are red; the selected pad stays white
  (and so does the one playing, if a chop moved playback elsewhere); the
  chop target is blue, unused slice pads are dim grey.
- Playback is one-shot by default: a pad plays its whole region and
  releasing it does not stop it. Pressing it again restarts the region.
  Filter & Setup Knob 4, Envelope Mode, switches all pads between Trigger
  (one-shot) and Gate (gated), as on Move. The Mute button does nothing.
  Play is passed through to Move (module.json button_passthrough), so it
  starts and stops the set to chop along with (set tempo and metronome in
  Move first).
  Gated is Move's A-S-R: full level while the pad that started the voice is held, then Decay is the
  release; Hold does nothing. Letting go of the blue pad after a chop keeps
  the gate open.
- Fine-tuning: chop points are linked. Moving a slice's start also moves the
  previous slice's end (and vice versa), so slices never gap or overlap.
  Only Pad 1's start and the last pad's end trim the sample. The selected
  slice is the one last played (or created by a chop); Left/Right change it.
  Main Knob 2 moves its start (Shift: zoom, as on Move; the start moves a
  screen column a detent, so zooming in is the fine adjust), Length (Main
  Knob 5 with Shift held) its end, a screen column a detent like the start,
  and the jog moves the start (only ever the start; jog click does nothing
  here). Shift gives fine steps on the jog. Length is shown as Move shows
  it: the slice as a percentage of the whole sample, one decimal below
  10%. (Move steps Length by 1/131 of the whole sample; LiveChopper keeps
  the column step, which gets finer zoomed in, since chops are often a
  small part of a long recording.)
- Blue pad pressed while nothing is playing: nothing happens.
- Pressing a chopped pad that is not playing: it plays its region and chokes
  whatever is playing.

- Delete (Delete button): removes the selected slice by merging it into the
  previous one, i.e. it removes a chop point. Deleting Pad 1 trims its audio
  off the start of the sample, so Pad 2 becomes Pad 1. Later pads shift down
  one. Undo restores it; undo covers chops and deletes and
  keeps the last 32 steps. Shift+Undo redoes what was undone, until a new
  chop, delete or chop point move.
- Back opens a menu: Keep for later / Discard and exit / Cancel, with
  Keep for later selected. The title warns "Not exported" if anything
  changed since the last export (chops, deletes, undo, redo, chop points,
  envelope, gate, gain, transpose, detune, the effect or the filter, even one only the Drum Preset carries; zoom and the knob page
  don't count); with
  nothing unexported the middle item is just "Exit".
- Keep for later (resume): stops any voice and hides the tool with
  host_hide_module(), leaving the DSP loaded. Schwung's Tools browser then
  offers "Resume: <file>". The DSP still holds the slices, undo/redo history
  and sound settings; the UI keeps zoom, the knob page, the exact knob
  positions and the unexported flag in the DSP (ui_state) and restores
  them. Use it to change tempo or
  the metronome in Move and come back. No project file: if another tool
  replaces the DSP meanwhile, resuming loads the sample fresh.
- Export menu (Record button, CC 118, as in the waveform editor): the name
  row on top (jog click opens the on-screen keyboard; starts as
  "<sample> Chop"), then Drum Preset / Slices / Cancel. Jog chooses, jog
  click runs it and closes the menu, Back or Record closes it. Capture does
  nothing. Either export clears the "not exported" state for the exit prompt.
- Export Slices: one WAV per pad in a new folder next to the sample,
  "<name>/<name> 01.wav", 02, ... (folder "<name> 2", 3, ... if taken). The
  DSP worker copies each slice's frames from the source file, so format, bit
  depth and channel count are kept; at a gain other than 0 dB each sample is
  scaled (PCM clips at full scale), at 0 dB they are copied as they are.
  The effect and the filter are left out, like the envelope and transpose.
- Export Drum Preset: one .ablpreset in UserLibrary/Track Presets,
  named "<name>" (then "<name> 2", 3, ... never overwritten). All 16
  pads point at the original WAV with Voice_PlaybackStart/Length set to their
  slice, so no audio is rewritten. Pads without a slice are muted. Envelope
  is exported in seconds in A-H-D mode, or A-S-R when gated (Hold Inf =
  60 s, Move's top), at the knobs' exact values, transpose as Voice_Transpose, detune as Voice_Detune (in semitones, so -30 cents is -0.3), gain as
  Voice_Gain (linear amplitude, 1.0 = 0 dB, -70 to +24 dB as on Move),
  the effect as Move's Effect_Type ("Stretch", "Loop", "Pitch Env", "Punch",
  "8-bit", "FM", "Ring Mod", "Sub Osc", "Noise") with its two Effect_*
  fields at the knobs' exact values (the other effects' fields at Move's
  defaults, Loop Offset 0.0),
  the filter as Voice_Filter_Type ("Lowpass 12dB", "Lowpass", "Highpass",
  "Peak"), Voice_Filter_Frequency in Hz, Voice_Filter_Resonance (0-0.9) and
  Voice_Filter_PeakGain (linear, 1.0 = 0 dB), so the default filter is
  Move's own default,
  all pads in choke group 1. The sample must be inside the
  User Library (the tool's file browser only offers files there).
- Tools menu (Shift + jog click): Normalize audio / Channels / Back. Jog
  chooses, jog click runs it, Back closes it (from a submenu: back up to
  Tools). Not available while an export or a conversion runs.
- Normalize audio: sets Gain so the sample's peak is at 0 dBFS, at once (no
  prompt). The DSP finds the peak at the file's full precision when it loads
  it and reports the gain, rounded down to 0.1 dB so it never clips. Nothing
  is written; the Gain knob adjusts it from there. A silent file leaves Gain alone
  ("Sample is silent").
- Channels: Mono (L+R) / Left only / Right only / Back, for a stereo (or
  multichannel) sample; a 1-channel one just says "Already mono". Each asks
  "Make mono?" / "Keep left only?" / "Keep right only?", "Replaces the
  file", Yes / No starting on No (Back is No). Yes rewrites the sample in
  place as a 1-channel WAV at its own format, bit depth and rate: the mean
  of the channels, or the first or second channel. The DSP worker writes a
  temp file next to it (keeping owner and permissions), loads it, and only
  then renames it over the original, so a failure leaves the original and
  the playing audio as they were; "Converting..." shows until the new audio
  is playing. Other chunks (cue points, loops, LIST info) are kept;
  per-channel ones (PEAK, chna) are dropped. A symlinked sample has its
  target rewritten; one with other hard links is refused ("File is
  hard-linked"). A file cut short (data chunk longer than the file)
  converts the frames that are there, as it plays. Slices, undo history,
  Gain and any voice playing are kept. It can't be undone, and presets
  already exported from the sample play it converted too. It counts as
  unexported work (exported slice WAVs no longer match).
