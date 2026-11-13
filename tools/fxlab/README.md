# fxlab

Tools for matching LiveChopper's effects to Move's Drum Sampler
(docs/PLAN.md, step 4). Nothing here is needed to build or install the
module.

- `setup_env.sh`: the Python venv in `build/.venv` (numpy, scipy,
  matplotlib, pinned in `requirements.txt`). Needs uv.
- `make_test_wavs.py`: the test sounds, written to `build/test_wavs/`.
- `fxlab.py`: splits a Move recording into one piece per pad, renders the
  same pads through plugin.c (`fx_render.c`), compares the two, and saves
  or checks the references in `tests/move_refs/`. Run it with
  `build/.venv/bin/python`.
- `knob_readout.mjs`: Move's knob readouts, used by `fxlab.py accept-set`.

Once the venv exists, `scripts/test.sh` runs `make_test_wavs.py`,
`tests/fxlab_selftest.py` and `fxlab.py refs-check`.
