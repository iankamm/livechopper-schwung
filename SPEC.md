# Chopper spec

A tool for Ableton Move (Schwung) that chops a sample across pads in real time,
like the chop modes on MPC and SP drum machines, then exports the result as a
Move drum rack preset.

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

- Transpose: repitch the sample (see open questions for per-pad vs global).
- Fine-tune chop points afterwards with knobs/jog and a waveform view, borrowing
  from the waveform editor's marker and zoom UI.
- Export menu on the Record button, like the waveform editor's: rename,
  export Slices (one WAV per pad), export a Drum Preset, or Cancel.
- Undo the last chop or delete; Shift+Undo redoes it.
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
- Transpose: repitch only (changes length and pitch together), one global
  setting (Knob 8, -24 to +24 semitones).
- Envelope: one global attack, hold and decay (AHD, matching the Move drum
  sampler's A-H-D mode) applied to every slice in chop mode and carried into
  the export for every pad. Knobs 5/6/7. Default: attack 0, hold Full (until
  the slice ends), short decay, so slices sound like the raw sample. A chop
  does not retrigger the envelope. This mode is for chopping; per-pad sound
  shaping is done in the drum rack after export.
- Declick: when a pad cuts off another, the old voice fades out over ~1.5 ms.
- Waveform vertical scale: Knob 4, 1x to 32x, as in the waveform editor.
- Choke: all pads choke each other by default, in chop mode and in the exported
  drum rack preset (supported: every pad gets the same chokeGroup).
- Pad colors: playable slice pads are red, the pad that is currently playing
  is white, the chop target is blue, unused slice pads are dim grey.
- Playback is one-shot: a pad plays its whole region and releasing it does
  not stop it. Pressing it again restarts the region. Gate behavior is left
  to the user to set in the exported drum rack.
- Fine-tuning: chop points are linked. Moving a slice's start also moves the
  previous slice's end (and vice versa), so slices never gap or overlap.
  Only Pad 1's start and the last pad's end trim the sample. The selected
  slice is the one last played (or created by a chop); Left/Right change it.
  Knob 1 moves its start, Knob 2 its end, Knob 3 zooms, the jog moves the
  active marker and jog click switches start/end. Shift gives fine steps.
- Blue pad pressed while nothing is playing: nothing happens.
- Pressing a chopped pad that is not playing: it plays its region and chokes
  whatever is playing.

- Delete (Delete button): removes the selected slice by merging it into the
  previous one, i.e. it removes a chop point. Deleting Pad 1 trims its audio
  off the start of the sample, so Pad 2 becomes Pad 1. Later pads shift down
  one. Undo restores it; undo covers chops and deletes and
  keeps the last 32 steps. Shift+Undo redoes what was undone, until a new
  chop, delete or chop point move.
- Exit (Back): if anything changed since the last export (chops, deletes,
  undo, redo, chop points, envelope, transpose), ask first: Discard and exit /
  Cancel (Discard and exit starts selected). Zoom and waveform scale don't count.
- Export menu (Record button, CC 118, as in the waveform editor): the name
  row on top (jog click opens the on-screen keyboard; starts as
  "<sample> Chop"), then Slices / Drum Preset / Cancel. Jog chooses, jog
  click runs it and closes the menu, Back or Record closes it. Capture does
  nothing. Either export clears the "not exported" state for the exit prompt.
- Export Slices: one WAV per pad in a new folder next to the sample,
  "<name>/<name> 01.wav", 02, ... (folder "<name> 2", 3, ... if taken). The
  DSP worker copies each slice's frames straight from the source file, so
  format, bit depth and channel count are kept.
- Export Drum Preset: one .ablpreset in UserLibrary/Track Presets,
  named "<name>" (then "<name> 2", 3, ... never overwritten). All 16
  pads point at the original WAV with Voice_PlaybackStart/Length set to their
  slice, so no audio is rewritten. Pads without a slice are muted. Envelope
  is exported in seconds in A-H-D mode (hold Full = 60 s), transpose as
  Voice_Transpose, all pads in choke group 1. The sample must be inside the
  User Library (the tool's file browser only offers files there).
