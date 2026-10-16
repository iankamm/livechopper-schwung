# Chopper: a Schwung module

This repo is a standalone module for the Schwung framework on Ableton Move.
We do NOT modify the framework. Never edit files outside this repo.

Feature spec: SPEC.md. Read it before proposing or writing code.

## Reference material (read-only)

Framework: ../schwung
- Module authoring guide: ../schwung/docs/MODULES.md (module.json, tool_config,
  help.json, plugin API v2, realtime-safety rules)
- JS API for UIs: ../schwung/docs/API.md
- Plugin header: ../schwung/src/host/plugin_api_v1.h
- Shared JS: ../schwung/src/shared/ (constants.mjs, input_filter.mjs,
  screen_reader.mjs, menu_*.mjs)
- ../schwung/CLAUDE.md is huge and mostly about framework internals. Only read
  these sections: "Code Style", "Build / Deploy", "Device Constraints",
  "Architecture", "Move Hardware MIDI", "Realtime Safety".

Base module: ../schwung-waveform-editor (MIT licensed, keep its copyright
notice on anything copied). Mirror its repo layout, build/install scripts,
release.json and GitHub workflow. Also read its own CLAUDE.md.

## Conventions

- Module ID lowercase-hyphenated; param keys lowercase_underscored.
- C: snake_case. JS: .mjs for shared modules, .js for UI entry points.
- Must ship help.json (lines of 20 characters or fewer) and screen-reader
  announcements via screen_reader.mjs.
- Native DSP entry points (create_instance, set_param, get_param, on_midi,
  render_block) all run on the realtime audio thread: no malloc/free, no file
  I/O, no logging, no locks, no unbounded loops. Load WAVs on a SCHED_OTHER
  worker thread and publish by pointer swap.
- On the Move, never write to /tmp. Use /data/UserData/.

## Hardware facts

- Pads are notes 68-99 (32 pads). Knobs CC 71-78, jog turn CC 14, jog click
  CC 3, Shift CC 49, Back CC 51.
- Display is 128x64, 1-bit.

## Workflow

- Build: ./scripts/build.sh (uses the local aarch64-linux-gnu-gcc). Before
  each build, run node tests/ui_smoke.mjs: it runs ui.js with a fake host and
  DSP and catches JS errors the device would otherwise hit first.
- Small steps. After each working step, stop and tell me what to test on the
  device and what to look for.
- Do not deploy to the device or run ssh commands without asking first.
- Logs on device: /data/UserData/schwung/debug.log (see ../schwung/CLAUDE.md
  "Testing" for how to enable).
