# Design notes

Findings from studying the framework and schwung-waveform-editor (v0.7.3),
2026-10-15. Answers and open points for SPEC.md.

## Sample-accurate chops: DSP owns pad input

- In an interactive tool (overtake_mode 2) the shim delivers internal pad
  note-on/off to the tool DSP's `on_midi` on the audio thread
  (schwung `src/schwung_shim.c`, "Deliver internal cable-0 note events").
  The same events also reach `onMidiMessageInternal` in ui.js.
- So chop logic lives in the DSP: on note-on, read the playhead right there
  and split. The UI only mirrors state (LEDs, screen) by polling get_param.
- Granularity: `on_midi` runs between blocks, so T is the playhead at the
  block boundary where the note is processed (128 frames, ~2.9 ms). There is
  no intra-block timestamp in the API. This matches SPEC item 7.
- The waveform editor's "Lazy" chop mode does NOT do this: it reads `playPos`
  in the UI (polled per tick), so its chops are tick-accurate at best. Don't
  copy it.

## Realtime safety

- The waveform editor loads WAVs with fopen/malloc inside `set_param`, which
  breaks the rules in plugin_api_v1.h. Don't copy that loader as-is.
- Plan: `set_param("file_path")` only copies the path and signals a worker
  thread (SCHED_OTHER, pinned to cores 0-2) created in `create_instance`. The
  worker loads and publishes a buffer pointer; render plays silence until it
  lands. Old buffers are freed by the worker, never on the audio thread.
- For an overtake tool, create/destroy run on the shim worker, so allocation
  and pthread_create there are fine.

## Export (drum rack preset)

- The waveform editor's `saveDrumRackPreset()` (ui.js) writes an
  `.ablpreset` JSON to `/data/UserData/UserLibrary/Track Presets/`. It is
  pure JS, so it can be reused almost verbatim.
- It uses ONE WAV for all pads: every drumCell points at the same
  `sampleUri` with `Voice_PlaybackStart` / `Voice_PlaybackLength` as
  fractions of the file. That's the simplest export option. Writing one WAV
  per slice would only be needed if those fields turn out too imprecise.
- Choke: each pad has `drumZoneSettings.chokeGroup`, already set to 1 for all
  16 pads. Choke-all is supported.
- Transpose: `Voice_Transpose` per drumCell, so global transpose can be
  exported.
- ADSR: the drumCell envelope is `Voice_Envelope_Attack/Hold/Decay` with
  `Voice_Envelope_Mode: "A-H-D"`. Decided: per-slice envelope is AHD (see
  below), which maps directly onto these fields.
- The preset always has 16 chains (receivingNote 36-51); unused pads get
  `speakerOn: false`.

## Decisions made after SPEC.md (2026-10-15)

SPEC.md is read-only (root-owned), so these override it until it's updated:

- Pads: slice pads are the left 4x4 block, like a Move drum rack. Pad i
  (0-15) maps to note 68 + 8*floor(i/4) + i%4; Pad 1 = 68 (bottom-left),
  Pad 5 = 76. The waveform editor uses notes 68-83 (two rows of 8) instead;
  don't copy its pad indexing.
- Envelope: per-slice attack/hold/decay (AHD) instead of ADSR, matching the
  drum sampler's A-H-D mode, so it exports directly. Default for a new
  slice: attack 0, hold for the full slice, short decay.
