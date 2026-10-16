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
- Export to a default Move drum rack preset, the same way the waveform editor
  does. Find and reuse its export code.
- Undo the last chop.
- help.json and screen-reader announcements (chop made, pad selected, export
  done).

## Decisions

- Pads: 16 maximum, the same 16 pads the waveform editor and a Move drum rack
  use. When all 16 are used, no pad lights blue and further chops are ignored.
- Pad order: Pad 1 is the bottom-left pad, with the same pad numbering as the
  waveform editor and the rest of Move. Pads always stay in time order: pad N
  is the Nth slice of the sample. The blue pad is the next unused pad after
  the last slice. When a chop splits a slice in the middle of the list, the
  new slice is inserted directly after the slice that was playing, and every
  later slice moves up one pad. Example: with pads 1-3 chopped and Pad 4 blue,
  playing Pad 1 and pressing Pad 4 gives:
  Pad 1 = old start to T, Pad 2 = T to Pad 1's old end (the new slice),
  Pad 3 = old slice 2, Pad 4 = old slice 3, and Pad 5 lights blue.
  Playback continues on the new slice (now Pad 2), not on the pad pressed.
  Per-slice settings (ADSR) move with their slice when pads are reordered.
- Transpose: repitch only (changes length and pitch together), one global
  setting for now.
- ADSR: each slice has its own attack, decay, sustain and release, applied in
  chop mode playback and carried into the export. Default for a new slice:
  attack 0, full sustain, short release, so a fresh chop sounds like the raw
  sample without clicks. A new slice created by a chop copies the ADSR of the
  slice it was split from.
- Choke: all pads choke each other by default, in chop mode and in the exported
  drum rack preset (if the preset format supports choke).
- Blue pad pressed while nothing is playing: nothing happens.
- Pressing a chopped pad that is not playing: it plays its region and chokes
  whatever is playing.

## Still open (decide after studying the waveform editor)

- Export: one WAV with start/end per drum rack pad, or one WAV file per slice?
  Depends on what the waveform editor's export and the drum rack preset format
  support. Recommend an option with the tradeoffs.
- Confirm the drum rack preset format can express choke and per-pad ADSR; if
  not, say so.
- How ADSR is edited on the device (which knobs, on which pad). Propose
  something consistent with the waveform editor and Move.
