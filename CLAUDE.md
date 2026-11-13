# LiveChopper: a Schwung module

This repo is a standalone module for the Schwung framework on Ableton Move.
We do NOT modify the framework. Never edit files outside this repo.

Feature spec: docs/SPEC.md. Read it before proposing or writing code.
Planned work: docs/PLAN.md. Design findings: docs/NOTES.md. Release notes:
docs/releases/.

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
notice on anything copied). Mirror its repo layout, build/install scripts
and release.json. Our GitHub workflows started from its and have since
grown their own checks (CI's Schwung version matrix, the release-notes
check); keep those. Also read its own CLAUDE.md.

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

- Build: ./scripts/build.sh (the local aarch64-linux-gnu-gcc, else Docker).
  Before each build, run ./scripts/test.sh:
  - tests/dsp_test.c drives plugin.c on the host (gcc + ASan/UBSan, real
    worker thread and WAV files);
  - tests/knobs_test.mjs checks the knob model against Move's readouts;
  - tests/ui_smoke.mjs runs ui.js under node with a fake host and DSP,
    checking the exported preset too;
  - when build/.venv exists (scripts/setup_analysis_env.sh), the Move
    references: tests/fxlab_selftest.py and `fxlab.py refs-check`, which
    holds plugin.c to Move's recorded curves in tests/move_refs/ (an effect
    matched to Move adds its refs there, PLAN "Method"). CI skips these.

  Add checks there for each new feature. The pre-commit hook
  (scripts/install-hooks.sh) runs test.sh on every commit; never bypass it
  with --no-verify.
- Do not deploy to the device or run ssh commands without asking first.
  Agreeing to a device session isn't a go: wait for the user's "start"
  before recording, ssh or deploying.
- Guide the git flow: speak up at natural checkpoints (tests green, a feature
  or PLAN step done, a device check passed, before a risky refactor) and
  recommend the next step: commit, push, tag a release, branch, merge. Propose
  the message, tag or branch name. Do not run any of it without approval.
- Releases: the "Release vX.Y.Z" commit bumps src/module.json's version and
  adds docs/releases/vX.Y.Z.md, the user-facing changes since the last tag.
  The release workflow publishes that file as the release description and
  fails without it. Draft the notes for approval along with the tag.
- Logs on device: /data/UserData/schwung/debug.log (see ../schwung/CLAUDE.md
  "Testing" for how to enable).

## Local-only material

.claude/ is gitignored and stays on this machine:

- notes/: handoffs and device notes. For effect tuning, start with
  notes/step4-handoff.md.
- recordings/: Move takes and their Sets (Song.abl), by Set.
- ref/: Move's manual and Live's Drum Sampler reference.
- tools/ and captures/: reading the Move's screen, and what it captured.
