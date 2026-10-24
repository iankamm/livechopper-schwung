/*
 * LiveChopper UI
 *
 * Chop a sample across pads in real time. See SPEC.md.
 * 128x64 1-bit monochrome display, QuickJS runtime.
 *
 * The DSP owns pad input, the slice list, the selected slice and the
 * playhead (so chops are sample-accurate); this UI mirrors DSP state by
 * polling get_param and sends edits back with set_param.
 *
 * Chop points are shared: moving a slice's start also moves the previous
 * slice's end. The marker/zoom UI follows the waveform editor's.
 *
 * Controls: the knobs copy the two banks of Move's own Drum Sampler (Move
 * manual 15.9.1), so each control sits where Move has it. Down / Up switch
 * between them. Sound settings are global (every slice, and the export).
 *   Red pads   - Play that slice (chokes the others); selects it
 *   Blue pad   - While a slice plays: chop at the playhead
 *   Main page:
 *   Knob 1     - Transpose in semitones (repitch) | Shift: detune in cents
 *   Knob 2     - Move the selected slice's start  | Shift: zoom
 *   Knob 3-4   - Attack / Hold
 *   Knob 5     - Decay; Shift+tap switches it to Length (the slice's end,
 *                shown as a percentage of the sample) and back
 *   Knob 6     - Effect: Off / 8-Bit (the drum sampler's 8-Bit effect)
 *   Knob 7     - 8-Bit rate, 1.00 to 30.0 kHz
 *   Filter & Setup page:
 *   Knob 1     - Filter frequency, 30 Hz to 22 kHz
 *   Knob 2     - Resonance (0-90%), or Peak gain (+-12 dB) on Peak
 *   Knob 3     - Filter type: Low-Pass 12 / 24, High-Pass 24, Peak
 *   Knob 4     - Envelope mode: Trigger (one-shot) / Gate (plays while held)
 *   Knob 8     - Gain, -70 to +24 dB (the waveform follows it)
 *   Jog        - Move the selected slice's start
 *   Touch knob - Preview its value on the bottom line (and speak it)
 *   Knob LEDs  - Lit under the knobs that do something on this page,
 *                brighter with the value (the framework's knob_leds.mjs)
 *   Shift      - Fine steps for knobs and jog
 *   Down/Up    - Filter & Setup page / Main page
 *   Left/Right - Select previous/next slice
 *   Delete     - Delete the selected slice (merges it into the previous one)
 *   Undo       - Undo the last chop or delete  |  Shift+Undo: redo
 *   Record     - Export menu: rename, Drum Preset, Slices (one WAV per pad)
 *   Play       - Passed through to Move (module.json button_passthrough):
 *                plays/stops the set to practise along with
 *   Back       - Menu: Keep for later (hide; resume from Tools) / Discard
 *                and exit / Cancel
 *   Shift+Jog click - Tools menu: Normalize audio (sets Gain so the
 *                sample's peak is at 0 dBFS; the file is not changed) /
 *                Channels (Mono (L+R), Left only, Right only: asks first,
 *                then rewrites the file as 1 channel, keeping the slices)
 *                / Back
 */

import {
    MoveBack, MoveUndo, MoveRecord, MoveDelete, MoveShift, MoveLeft, MoveRight, MoveUp, MoveDown,
    MoveMainKnob, MoveMainButton, MoveKnob1, MoveKnob8,
    MovePads,
    Black, DarkGrey, White, BrightRed, PureBlue,
    WhiteLedOff, WhiteLedBright
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED, setButtonLED, decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { updateKnobLEDs, clearKnobLEDs, resetKnobLedCache }
    from '/data/UserData/schwung/shared/param_pages/knob_leds.mjs';

import { buildDrumRackPreset, sampleUriFor, PRESET_DIR } from './drum_rack.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("LiveChopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var CC_UNDO = MoveUndo;
var CC_RECORD = MoveRecord;      /* RGB LED */
var CC_DELETE = MoveDelete;
var CC_SHIFT = MoveShift;
var CC_LEFT = MoveLeft;
var CC_RIGHT = MoveRight;
var CC_UP = MoveUp;
var CC_DOWN = MoveDown;
var CC_JOG = MoveMainKnob;
var CC_JOG_CLICK = MoveMainButton;
var CC_E1 = MoveKnob1;          /* Knobs 1-8 are CCs 71-78 */
var CC_E8 = MoveKnob8;

var PAD_NOTE_MIN = MovePads[0];
var MAX_PADS = 16;
var COLOR_SLICE = BrightRed;    /* playable slice pad */
var COLOR_PLAYING = White;      /* slice pad that is selected or sounding */
var COLOR_TARGET = PureBlue;    /* chop target */
var COLOR_UNUSED = DarkGrey;

var SCREEN_W = 128;

/* Waveform area */
var WAVE_X = 2;
var WAVE_COLS = 124;
var WAVE_TOP = 10;
var WAVE_BOT = 47;
var WAVE_MID = Math.floor((WAVE_TOP + WAVE_BOT) / 2);
var WAVE_HALF = Math.floor((WAVE_BOT - WAVE_TOP) / 2);
var MINIMAP_Y = 49;

/* Zoom: view length = frames / 2^zoom, at least one frame per column. */
var ZOOM_MAX = 14;
var ZOOM_STEP = 0.25;
var FINE_DIVISOR = 16;          /* Shift: 1/16 of a coarse step */
var EDGE_MARGIN = 0.05;         /* recenter when a marker is this close to the edge */
var ANNOUNCE_SETTLE_TICKS = 20;
var OVERLAY_TICKS = 60;
var EXPORT_MSG_TICKS = 150;

/* Vertical scale, as in the waveform editor: scale *= 2^step per tick. */
/* Gain in tenths of a dB, -70 to +24 dB like Move's drum sampler.
 * 0.5 dB a step (Shift: 0.1) from -24 dB up, 2 dB below that. */
var GAIN_MIN = -700;
var GAIN_MAX = 240;
var GAIN_COARSE_FLOOR = -240;

/* Envelope knobs move a 0-1 position; time = max * pos^3 for fine control
 * near zero. Hold at the top of its range is Full (until the slice ends). */
var ATTACK_MAX_US = 2000000;
var HOLD_MAX_US = 5000000;
var DECAY_MAX_US = 10000000;
var HOLD_FULL = -1;
var ENV_KNOB_STEP = 0.01;
var ENV_KNOB_FINE = 0.002;
var TRANSPOSE_MIN = -48;         /* semitones, as on Move's drum sampler */
var TRANSPOSE_MAX = 48;
var DETUNE_MIN = -50;            /* cents */
var DETUNE_MAX = 50;
/* Log steps from lo up to hi, perOctave to the octave, each rounded by
 * round(); repeats are dropped and the last step is hi. */
function logSteps(lo, hi, perOctave, round) {
    var steps = [];
    for (var i = 0; ; i++) {
        var v = round(lo * Math.pow(2, i / perOctave));
        if (v >= hi) break;
        if (steps.length === 0 || v !== steps[steps.length - 1]) steps.push(v);
    }
    steps.push(hi);
    return steps;
}

/* Crush rates, as the drum sampler's 8-Bit Resampling Rate (1-30 kHz): log
 * steps of 1/24 octave (Shift: 1/96), rounded as Move shows them (10 Hz
 * below 10 kHz, 100 Hz above). */
var CRUSH_MIN_HZ = 1000;
var CRUSH_MAX_HZ = 30000;
var CRUSH_DEFAULT_HZ = 14080;   /* Move's default rate */
function roundCrush(hz) {
    var unit = hz < 10000 ? 10 : 100;
    return Math.round(hz / unit) * unit;
}
var CRUSH_STEPS = logSteps(CRUSH_MIN_HZ, CRUSH_MAX_HZ, 24, roundCrush);
var CRUSH_FINE_STEPS = logSteps(CRUSH_MIN_HZ, CRUSH_MAX_HZ, 96, roundCrush);

/* Filter, in the drum sampler's ranges. Frequency in tenths of a Hz, 30 Hz
 * to 22 kHz in 1/24-octave steps (Shift: 1/96), rounded as Move shows it:
 * 0.1 Hz below 100 Hz, 1 Hz below 1 kHz, 10 Hz below 10 kHz, 100 Hz above. */
var FILTER_TYPE_NAMES = ["Low-Pass 12", "Low-Pass 24", "High-Pass 24", "Peak"];
var FILTER_LP24 = 1;
var FILTER_PEAK = 3;
var FILTER_HZ10_MIN = 300;
var FILTER_HZ10_MAX = 220000;
function roundFreq10(v) {
    var unit = v < 1000 ? 1 : v < 10000 ? 10 : v < 100000 ? 100 : 1000;
    return Math.round(v / unit) * unit;
}
var FREQ_STEPS = logSteps(FILTER_HZ10_MIN, FILTER_HZ10_MAX, 24, roundFreq10);
var FREQ_FINE_STEPS = logSteps(FILTER_HZ10_MIN, FILTER_HZ10_MAX, 96, roundFreq10);
var FILTER_RES_MAX = 900;       /* thousandths: Move's 0.9, shown as 90% */
var RES_STEP = 10;              /* 1% (Shift: 0.1%) */
var PEAK_DB10_MAX = 120;        /* +-12 dB, 0.5 dB steps (Shift: 0.1) */

/* Knob pages: Move's Drum Sampler banks */
var PAGE_MAIN = 0;
var PAGE_FILTER = 1;
var PAGE_NAMES = ["Main", "Filter & Setup"];
var PAGE_SPOKEN = ["Main page", "Filter and Setup page"];
var EDIT_TIMEOUT_MS = 100;

/* Slice pads are the left 4x4 block, like a Move drum rack.
 * Pad 1 is bottom-left, numbered left to right then upward. */
var PAD_COLS = 4;
var ROW_STRIDE = 8;

function padIndexToNote(i) {
    return PAD_NOTE_MIN + Math.floor(i / PAD_COLS) * ROW_STRIDE + (i % PAD_COLS);
}

/* ============ State ============ */

var filePath = "";
var fileName = "";

/* Mirrored from DSP status */
var loadState = "none";     /* none | loading | ready | error */
var frames = 0;
var sampleRate = 0;
var playing = false;
var playPos = 0;
var errorMsg = "";

/* Mirrored from DSP slices */
var chopCount = 0;
var undoCount = 0;
var undoDepth = 0;
var redoCount = 0;
var redoDepth = 0;
var playingSlice = -1;
var selectedSlice = 0;
var sliceCount = 0;
var sliceStarts = [];
var sliceEnds = [];

var lastLoadState = "";
var lastChopCount = 0;
var lastUndoCount = 0;
var lastRedoCount = 0;
var deleteCount = 0;
var lastDeleteCount = 0;

/* Unsaved work: bumped by every edit, remembered at each export. */
var editVersion = 0;
var exportedVersion = 0;

/* Back menu: keep the session for later, exit, or cancel */
var confirmExit = false;
var confirmIndex = 0;
var CONFIRM_KEEP = 0;
var CONFIRM_EXIT = 1;
var CONFIRM_CANCEL = 2;

/* Resume: the DSP keeps running while the tool is hidden, and holds a
 * short string of UI state for when it comes back. */
var resumed = false;        /* reconnected to a running session */
var countsSynced = false;   /* DSP edit counters adopted without announcing */
var lastUiState = "";

/* Export menu: row 0 is the name (click to rename), then the actions. */
var exportMenu = false;
var exportIndex = 0;
var exportName = "";
var EXPORT_ACTIONS = ["Drum Preset", "Slices", "Cancel"];
var sliceExport = null;     /* { seq, folder, version } while the DSP writes WAVs */
var SLICE_EXPORT_TIMEOUT_TICKS = 3000;

/* List menus: Tools (Shift + jog click), its Channels submenu and the
 * prompt before converting. { title, note, items, index, choose, back } */
var menu = null;
var TOOLS_ITEMS = ["Normalize audio", "Channels", "Back"];
var CHANNEL_ITEMS = ["Mono (L+R)", "Left only", "Right only", "Back"];
var CHANNEL_MODES = {
    "Mono (L+R)": { mode: "mono", ask: "Make mono?", done: "Mono", say: "Now mono" },
    "Left only": { mode: "left", ask: "Keep left only?", done: "Left only", say: "Now left channel only" },
    "Right only": { mode: "right", ask: "Keep right only?", done: "Right only", say: "Now right channel only" }
};
var convertJob = null;      /* { seq, mode, ticks } while the DSP rewrites the file */
var CONVERT_TIMEOUT_TICKS = 3000;
var CONV_FAILED = 0, CONV_OK = 1, CONV_ALREADY_MONO = 2, CONV_LINKED = 3;   /* plugin.c */
var lastSelectedSlice = -1;
var lastPlayingSlice = -1;
var buttonLedOn = {};        /* last on/off sent per button CC */
var exited = false;         /* no LED updates once we have handed back */
var padColors = [];         /* last color sent per pad index, to avoid LED spam */

/* Editing */
var shiftHeld = false;
var activeSide = 0;         /* 0 = start marker, 1 = end marker */
var zoom = 0;
var viewStart = 0;
var pendingNudge = null;    /* { slice, side, delta } sent once per tick */
var followMarker = false;   /* tick keeps the active marker in view after a nudge */
var announceTimer = 0;

/* Global sound settings (DSP holds the truth; read back on load) */
var attackUs = 0;
var holdUs = HOLD_FULL;
var decayUs = 50000;
var transpose = 0;
var detune = 0;             /* cents */
var gainDb10 = 0;           /* tenths of a dB, GAIN_MIN to GAIN_MAX */
var crushHz = 0;            /* 0 = off, else CRUSH_MIN_HZ to CRUSH_MAX_HZ */
var crushRate = CRUSH_DEFAULT_HZ;   /* the 8-Bit rate, kept while the effect is off */
var filterType = FILTER_LP24;
var filterHz10 = FILTER_HZ10_MAX;
var filterRes = 0;          /* thousandths, 0 to FILTER_RES_MAX */
var filterPeakDb10 = 0;     /* Peak gain, tenths of a dB */
var gated = false;          /* false = one-shot (A-H-D), true = gated (A-S-R) */
var attackKnob = 0;
var holdKnob = 1;
var decayKnob = 0;
var pendingSettings = {};   /* key -> value, sent once per tick */
var overlayText = "";       /* footer readout while a sound knob moves */
var overlayTimer = 0;
var touchedKnob = -1;       /* 0-7 while a knob is touched */
var tapKnob = -1;           /* knob touched with Shift held and not turned yet */
var page = PAGE_MAIN;
var lengthMode = false;     /* Main Knob 5 is Length (Shift+tap), not Decay */
var settingAnnounce = "";
var settingAnnounceTimer = 0;

/* Waveform cache */
var waveKey = "";
var wavePeaks = [];

/* ============ Helpers ============ */

function baseName(path) {
    var i = path.lastIndexOf("/");
    return i >= 0 ? path.substring(i + 1) : path;
}

/* "1.234 s", or "1.234s" with attached set (the bottom line's S / L). */
function formatSeconds(f, attached) {
    var unit = attached ? "s" : " s";
    if (!sampleRate) return "0.000" + unit;
    return (f / sampleRate).toFixed(3) + unit;
}

function spokenSeconds(f) {
    if (!sampleRate) return "0 seconds";
    return (f / sampleRate).toFixed(3) + " seconds";
}

function setParamNow(key, value) {
    if (typeof host_module_set_param_blocking === "function") {
        host_module_set_param_blocking(key, value, EDIT_TIMEOUT_MS);
    } else {
        host_module_set_param(key, value);
    }
}

function pollStatus() {
    var raw = host_module_get_param("status");
    if (!raw) return;
    var p = raw.split(" ");
    loadState = p[0];
    frames = parseInt(p[1], 10) || 0;
    sampleRate = parseInt(p[2], 10) || 0;
    playing = p[3] === "1";
    playPos = parseInt(p[4], 10) || 0;
}

function pollSlices() {
    var raw = host_module_get_param("slices");
    if (!raw) return;
    var p = raw.split(" ");
    chopCount = parseInt(p[0], 10) || 0;
    undoCount = parseInt(p[1], 10) || 0;
    deleteCount = parseInt(p[2], 10) || 0;
    undoDepth = parseInt(p[3], 10) || 0;
    redoCount = parseInt(p[4], 10) || 0;
    redoDepth = parseInt(p[5], 10) || 0;
    playingSlice = parseInt(p[6], 10);
    selectedSlice = parseInt(p[7], 10) || 0;
    sliceCount = parseInt(p[8], 10) || 0;
    sliceStarts = [];
    sliceEnds = [];
    for (var i = 0; i < sliceCount; i++) {
        sliceStarts.push(parseInt(p[9 + i * 2], 10) || 0);
        sliceEnds.push(parseInt(p[10 + i * 2], 10) || 0);
    }
}

/* ============ View ============ */

function viewLen() {
    var len = Math.floor(frames / Math.pow(2, zoom));
    return Math.max(Math.min(WAVE_COLS, frames), len);
}

function clampView() {
    var len = viewLen();
    if (viewStart > frames - len) viewStart = frames - len;
    if (viewStart < 0) viewStart = 0;
}

function activeMarkerPos() {
    if (selectedSlice >= sliceCount) return 0;
    return activeSide === 0 ? sliceStarts[selectedSlice] : sliceEnds[selectedSlice];
}

function centerOn(pos) {
    viewStart = pos - Math.floor(viewLen() / 2);
    clampView();
}

/* Zoom always centers on the selected slice's start, whichever marker is active. */
function centerOnStart() {
    followMarker = false;
    if (selectedSlice < sliceCount) centerOn(sliceStarts[selectedSlice]);
}

/* Bring a newly selected or played slice into view: its start always, and its
 * end too when the whole slice fits. Scrolls as little as needed. */
function revealSlice() {
    followMarker = false;
    if (selectedSlice >= sliceCount) return;
    var len = viewLen();
    var margin = Math.floor(len * EDGE_MARGIN);
    var s = sliceStarts[selectedSlice];
    var e = sliceEnds[selectedSlice];
    if (e - s <= len - 2 * margin) {
        if (s < viewStart + margin) viewStart = s - margin;
        else if (e > viewStart + len - margin) viewStart = e - len + margin;
    } else if (s < viewStart + margin || s > viewStart + len - margin) {
        centerOn(s);
    }
    clampView();
}

/* Scroll only when the active marker nears the edge of the view. */
function keepMarkerVisible() {
    var len = viewLen();
    var pos = activeMarkerPos();
    var margin = Math.floor(len * EDGE_MARGIN);
    if (pos < viewStart + margin || pos > viewStart + len - margin) centerOn(pos);
    clampView();
}

function frameToX(f) {
    return WAVE_X + Math.floor((f - viewStart) * WAVE_COLS / viewLen());
}

function refreshWave() {
    var len = viewLen();
    var key = "wave " + viewStart + " " + (viewStart + len) + " " + WAVE_COLS;
    if (key === waveKey) return;
    var raw = host_module_get_param(key);
    if (!raw || raw.length < WAVE_COLS * 2) return;
    waveKey = key;
    wavePeaks = [];
    for (var c = 0; c < WAVE_COLS; c++) {
        wavePeaks.push(parseInt(raw.substr(c * 2, 2), 16));
    }
}

/* ============ Editing ============ */

function coarseStep() {
    return Math.max(1, Math.round(viewLen() / WAVE_COLS));
}

function setActiveSide(side) {
    if (side === activeSide) return;
    activeSide = side;
    keepMarkerVisible();
}

function queueNudge(side, ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    if (touchedKnob < 0) overlayTimer = 0;
    setActiveSide(side);
    var step = shiftHeld ? Math.max(1, Math.round(coarseStep() / FINE_DIVISOR)) : coarseStep();
    if (pendingNudge && (pendingNudge.slice !== selectedSlice || pendingNudge.side !== side)) {
        flushNudge();
    }
    if (!pendingNudge) pendingNudge = { slice: selectedSlice, side: side, delta: 0 };
    pendingNudge.delta += ticks * step;
    announceTimer = ANNOUNCE_SETTLE_TICKS;
    followMarker = true;
}

function flushNudge() {
    if (!pendingNudge || pendingNudge.delta === 0) {
        pendingNudge = null;
        return;
    }
    setParamNow("nudge", pendingNudge.slice + " " + pendingNudge.side + " " + pendingNudge.delta);
    pendingNudge = null;
    editVersion++;
}

function deleteSelected() {
    if (loadState !== "ready") return;
    if (sliceCount < 2) {
        announce("Only one slice, nothing to delete");
        return;
    }
    flushNudge();
    setParamNow("delete", String(selectedSlice));
}

function changeZoom(ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    zoom += ticks * ZOOM_STEP;
    if (zoom < 0) zoom = 0;
    if (zoom > ZOOM_MAX) zoom = ZOOM_MAX;
    centerOnStart();
}

function selectSlice(idx) {
    if (loadState !== "ready" || sliceCount === 0) return;
    if (idx < 0) idx = sliceCount - 1;
    if (idx >= sliceCount) idx = 0;
    flushNudge();
    setParamNow("select", String(idx));
}

/* ============ Sound settings ============ */

function formatUs(us) {
    if (us === HOLD_FULL) return "Full";
    if (us < 10000) return (us / 1000).toFixed(1) + " ms";
    if (us < 1000000) return Math.round(us / 1000) + " ms";
    return (us / 1000000).toFixed(2) + " s";
}

function spokenUs(us) {
    if (us === HOLD_FULL) return "full";
    if (us < 1000000) return (Math.round(us / 100) / 10) + " milliseconds";
    return (Math.round(us / 10000) / 100) + " seconds";
}

function formatTranspose(t) {
    return (t > 0 ? "+" : "") + t + " st";
}

function formatDetune(c) {
    return (c > 0 ? "+" : "") + c + " ct";
}

/* Hz as Move shows it: "30.0 Hz", "250 Hz", "1.20 kHz", "12.5 kHz". */
function formatHz(hz) {
    if (hz < 100) return hz.toFixed(1) + " Hz";
    if (hz < 1000) return Math.round(hz) + " Hz";
    return (hz / 1000).toFixed(hz < 10000 ? 2 : 1) + " kHz";
}

function spokenHz(hz) {
    if (hz < 1000) return (Math.round(hz * 10) / 10) + " hertz";
    return (Math.round(hz) / 1000) + " kilohertz";
}

/* A percentage as Move shows it: one decimal below 10, none from 10 up. */
function formatPercent(x) {
    var r = Math.round(x * 10) / 10;
    return r < 10 ? r.toFixed(1) : String(Math.round(r));
}

/* Move ticks steps along a sorted table from value. A value between steps
 * reaches the next one on the first step. Stops at either end. */
function tableStep(table, value, ticks) {
    var i = 0;
    while (i < table.length - 1 && table[i] < value) i++;
    if (table[i] > value && ticks > 0) i--;
    i += ticks;
    return table[Math.max(0, Math.min(table.length - 1, i))];
}

function clampInt(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

function knobToUs(pos, maxUs) {
    return Math.round(maxUs * pos * pos * pos);
}

function usToKnob(us, maxUs) {
    if (us <= 0) return 0;
    return Math.min(1, Math.cbrt(us / maxUs));
}

function readSettings() {
    var raw = host_module_get_param("settings");
    if (!raw) return;
    var p = raw.split(" ");
    attackUs = parseInt(p[0], 10) || 0;
    holdUs = parseInt(p[1], 10);
    if (isNaN(holdUs)) holdUs = HOLD_FULL;
    decayUs = parseInt(p[2], 10) || 0;
    transpose = parseInt(p[3], 10) || 0;
    gated = p[4] === "1";
    detune = parseInt(p[5], 10) || 0;
    gainDb10 = Math.max(GAIN_MIN, Math.min(GAIN_MAX, parseInt(p[6], 10) || 0));
    crushHz = parseInt(p[7], 10) || 0;
    if (crushHz > 0) crushRate = crushHz;
    filterType = clampInt(parseInt(p[8], 10), 0, FILTER_TYPE_NAMES.length - 1);
    if (isNaN(filterType)) filterType = FILTER_LP24;
    filterHz10 = parseInt(p[9], 10) || FILTER_HZ10_MAX;
    filterRes = parseInt(p[10], 10) || 0;
    filterPeakDb10 = parseInt(p[11], 10) || 0;
    attackKnob = usToKnob(attackUs, ATTACK_MAX_US);
    holdKnob = holdUs === HOLD_FULL ? 1 : usToKnob(holdUs, HOLD_MAX_US);
    decayKnob = usToKnob(decayUs, DECAY_MAX_US);
}

/* On: gated (Move's Gate mode, A-S-R); off: one-shot (Trigger, A-H-D). */
function setGate(on) {
    gated = on;
    pendingSettings.gate = gated ? 1 : 0;
}

/* What knob i (0-7) does right now: it depends on the page, Shift, the
 * Knob 5 toggle and, for Filter Knob 2, the filter type. */
function knobRole(i) {
    if (page === PAGE_MAIN) {
        switch (i) {
        case 0: return shiftHeld ? "detune" : "transpose";
        case 1: return shiftHeld ? "zoom" : "start";
        case 2: return "attack";
        case 3: return "hold";
        case 4: return lengthMode ? "length" : "decay";
        case 5: return "effect";
        case 6: return "rate";
        default: return "none";
        }
    }
    switch (i) {
    case 0: return "frequency";
    case 1: return filterType === FILTER_PEAK ? "peak" : "resonance";
    case 2: return "type";
    case 3: return "mode";
    case 7: return "gain";
    default: return "none";
    }
}

/* Where v sits from lo to hi on a log scale, 0..1. */
function logPos(v, lo, hi) {
    return Math.log(v / lo) / Math.log(hi / lo);
}

/* Knob i's value as 0..1 for its LED, or null while turning it does nothing
 * (no role, or Rate with the effect off): the LED is dark then. */
function knobLevel(i) {
    switch (knobRole(i)) {
    case "transpose": return (transpose - TRANSPOSE_MIN) / (TRANSPOSE_MAX - TRANSPOSE_MIN);
    case "detune":    return (detune - DETUNE_MIN) / (DETUNE_MAX - DETUNE_MIN);
    case "start":     return frames > 0 ? sliceStarts[selectedSlice] / frames : 0;
    case "zoom":      return zoom / ZOOM_MAX;
    case "attack":    return attackKnob;
    case "hold":      return holdKnob;
    case "decay":     return decayKnob;
    case "length":    return lengthPercent() / 100;
    case "effect":    return crushHz > 0 ? 1 : 0;
    case "rate":      return crushHz > 0 ? logPos(crushHz, CRUSH_MIN_HZ, CRUSH_MAX_HZ) : null;
    case "frequency": return logPos(filterHz10, FILTER_HZ10_MIN, FILTER_HZ10_MAX);
    case "resonance": return filterRes / FILTER_RES_MAX;
    case "peak":      return (filterPeakDb10 + PEAK_DB10_MAX) / (2 * PEAK_DB10_MAX);
    case "type":      return filterType / (FILTER_TYPE_NAMES.length - 1);
    case "mode":      return gated ? 1 : 0;
    case "gain":      return (gainDb10 - GAIN_MIN) / (GAIN_MAX - GAIN_MIN);
    default:          return null;
    }
}

/* The selected slice's length as a percentage of the sample, as Move shows
 * Length (and as the export writes Voice_PlaybackLength). */
function lengthPercent() {
    if (sliceCount === 0 || frames <= 0) return 0;
    return (sliceEnds[selectedSlice] - sliceStarts[selectedSlice]) * 100 / frames;
}

/* [screen text, spoken text] for knob i (0-7), from current values. */
function knobReadout(i) {
    var pad = "Pad " + (selectedSlice + 1);
    switch (knobRole(i)) {
    case "transpose":
        return ["Transpose: " + formatTranspose(transpose), "Transpose " + transpose + " semitones"];
    case "detune":
        return ["Detune: " + formatDetune(detune), "Detune " + detune + " cents"];
    case "start":
        var pos = sliceCount > 0 ? sliceStarts[selectedSlice] : 0;
        return ["Start: " + formatSeconds(pos), pad + " start " + spokenSeconds(pos)];
    case "zoom":
        var z = Math.round(Math.pow(2, zoom));
        return ["Zoom: x" + z, "Zoom " + z];
    case "attack":
        return ["Attack: " + formatUs(attackUs), "Attack " + spokenUs(attackUs)];
    case "hold":
        return ["Hold: " + formatUs(holdUs), "Hold " + spokenUs(holdUs)];
    case "decay":
        return ["Decay: " + formatUs(decayUs), "Decay " + spokenUs(decayUs)];
    case "length":
        var len = formatPercent(lengthPercent());
        return ["Length: " + len + " %", pad + " length " + len + " percent"];
    case "effect":
        return crushHz > 0 ? ["Effect: 8-Bit", "Effect 8-Bit"] : ["Effect: Off", "Effect off"];
    case "rate":
        if (crushHz <= 0) return ["-", "8-Bit rate, the effect is off"];
        return ["Rate: " + formatHz(crushHz), "8-Bit rate " + spokenHz(crushHz)];
    case "frequency":
        return ["Freq: " + formatHz(filterHz10 / 10), "Frequency " + spokenHz(filterHz10 / 10)];
    case "resonance":
        var res = formatPercent(filterRes / 10);
        return ["Resonance: " + res + " %", "Resonance " + res + " percent"];
    case "peak":
        return ["Peak Gain: " + formatGain(filterPeakDb10), "Peak gain " + spokenGain(filterPeakDb10)];
    case "type":
        return ["Type: " + FILTER_TYPE_NAMES[filterType], "Filter " + FILTER_TYPE_NAMES[filterType].toLowerCase()];
    case "mode":
        return gated ? ["Mode: Gate", "Mode gate"] : ["Mode: Trigger", "Mode trigger"];
    case "gain":
        return ["Gain: " + formatGain(gainDb10), "Gain " + spokenGain(gainDb10)];
    default:
        return ["-", "Not used"];
    }
}

/* Show knob i's value on the bottom line and speak it once it settles. */
function showKnob(i) {
    var r = knobReadout(i);
    overlayText = r[0];
    overlayTimer = OVERLAY_TICKS;
    settingAnnounce = r[1];
    settingAnnounceTimer = ANNOUNCE_SETTLE_TICKS;
}

/* Show knob i's value and speak it now. */
function sayKnob(i) {
    var r = knobReadout(i);
    overlayText = r[0];
    overlayTimer = OVERLAY_TICKS;
    announce(r[1]);
}

function onKnobTouch(i, touched) {
    if (!touched) {
        if (touchedKnob === i) touchedKnob = -1;
        /* Shift+tap (touched with Shift held, let go without turning) */
        if (tapKnob === i) {
            tapKnob = -1;
            toggleLength();
        }
        return;
    }
    if (loadState !== "ready") return;
    touchedKnob = i;
    var role = knobRole(i);
    tapKnob = shiftHeld && (role === "decay" || role === "length") ? i : -1;
    if (role === "start" || role === "length") setActiveSide(role === "start" ? 0 : 1);
    if (role === "zoom") centerOnStart();
    sayKnob(i);
}

/* Shift+tap Knob 5: Decay <-> Length, as on Move. */
function toggleLength() {
    if (loadState !== "ready" || page !== PAGE_MAIN) return;
    lengthMode = !lengthMode;
    setActiveSide(lengthMode ? 1 : 0);
    sayKnob(4);
}

/* Down / Up: Filter & Setup / Main. */
function setPage(p) {
    if (loadState !== "ready" || sliceCount === 0) return;
    page = p;
    tapKnob = -1;
    showMessage(PAGE_NAMES[page], OVERLAY_TICKS);
    announce(PAGE_SPOKEN[page]);
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

/* Turn knob i by ticks detents: whatever its role is right now. */
function turnKnob(i, ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    if (tapKnob === i) tapKnob = -1;        /* turned: not a tap */
    var fine = shiftHeld;
    var envStep = (fine ? ENV_KNOB_FINE : ENV_KNOB_STEP) * ticks;
    var v;
    switch (knobRole(i)) {
    case "start":
        queueNudge(0, ticks);
        return;
    case "length":
        queueNudge(1, ticks);
        return;
    case "zoom":
        changeZoom(ticks);
        break;
    case "transpose":
        transpose = clampInt(transpose + ticks, TRANSPOSE_MIN, TRANSPOSE_MAX);
        pendingSettings.transpose = transpose;
        break;
    case "detune":
        detune = clampInt(detune + ticks, DETUNE_MIN, DETUNE_MAX);
        pendingSettings.detune = detune;
        break;
    case "attack":
        attackKnob = clamp01(attackKnob + envStep);
        attackUs = knobToUs(attackKnob, ATTACK_MAX_US);
        pendingSettings.attack_us = attackUs;
        break;
    case "hold":
        holdKnob = clamp01(holdKnob + envStep);
        holdUs = holdKnob >= 1 ? HOLD_FULL : knobToUs(holdKnob, HOLD_MAX_US);
        pendingSettings.hold_us = holdUs;
        break;
    case "decay":
        decayKnob = clamp01(decayKnob + envStep);
        decayUs = knobToUs(decayKnob, DECAY_MAX_US);
        pendingSettings.decay_us = decayUs;
        break;
    case "effect":
        v = ticks > 0 ? crushRate : 0;
        if (v !== crushHz) {
            crushHz = v;
            pendingSettings.crush_hz = crushHz;
        }
        break;
    case "rate":
        if (crushHz <= 0) break;            /* the effect is off */
        v = tableStep(fine ? CRUSH_FINE_STEPS : CRUSH_STEPS, crushRate, ticks);
        if (v !== crushHz) {
            crushRate = crushHz = v;
            pendingSettings.crush_hz = crushHz;
        }
        break;
    case "frequency":
        v = tableStep(fine ? FREQ_FINE_STEPS : FREQ_STEPS, filterHz10, ticks);
        if (v !== filterHz10) {
            filterHz10 = v;
            pendingSettings.filter_hz10 = filterHz10;
        }
        break;
    case "resonance":
        v = clampInt(filterRes + ticks * (fine ? 1 : RES_STEP), 0, FILTER_RES_MAX);
        if (v !== filterRes) {
            filterRes = v;
            pendingSettings.filter_res = filterRes;
        }
        break;
    case "peak":
        v = clampInt(filterPeakDb10 + ticks * (fine ? 1 : 5), -PEAK_DB10_MAX, PEAK_DB10_MAX);
        if (v !== filterPeakDb10) {
            filterPeakDb10 = v;
            pendingSettings.filter_peak_db10 = filterPeakDb10;
        }
        break;
    case "type":
        v = clampInt(filterType + ticks, 0, FILTER_TYPE_NAMES.length - 1);
        if (v !== filterType) {
            filterType = v;
            pendingSettings.filter_type = filterType;
        }
        break;
    case "mode":
        if ((ticks > 0) !== gated) setGate(ticks > 0);
        break;
    case "gain":
        v = gainDb10;
        for (var n = 0; n < Math.abs(ticks); n++) v = gainStep(v, ticks > 0 ? 1 : -1);
        setGain(v);
        break;
    }
    showKnob(i);
}

function flushSettings() {
    for (var key in pendingSettings) {
        setParamNow(key, String(pendingSettings[key]));
        editVersion++;
    }
    pendingSettings = {};
}

function gainLinear(db10) {
    return Math.pow(10, db10 / 200);
}

function formatGain(db10) {
    return (db10 > 0 ? "+" : db10 < 0 ? "-" : "") + (Math.abs(db10) / 10).toFixed(1) + " dB";
}

function spokenGain(db10) {
    return (db10 > 0 ? "plus " : db10 < 0 ? "minus " : "") + (Math.abs(db10) / 10).toFixed(1) + " decibels";
}

/* One knob step up (dir 1) or down (dir -1) from db10. */
function gainStep(db10, dir) {
    var coarse = dir > 0 ? db10 < GAIN_COARSE_FLOOR : db10 <= GAIN_COARSE_FLOOR;
    var v = db10 + dir * (coarse ? 20 : (shiftHeld ? 1 : 5));
    if (v > GAIN_MAX) return GAIN_MAX;
    if (v < GAIN_MIN) return GAIN_MIN;
    return v;
}

function setGain(db10) {
    gainDb10 = db10;
    pendingSettings.gain_db10 = gainDb10;
}

/* ============ Export ============ */

/* "<name> Chop", or "<name> Chop 2", 3, ... so nothing is overwritten. */
/* Keyboard input becomes part of a file name: no slashes, no leading dot. */
function cleanName(name) {
    return String(name || "").replace(/[\/\\]/g, "-").replace(/^[.\s]+/, "").replace(/\s+$/, "");
}

/* First of "<base>", "<base> 2", "<base> 3", ... for which exists() is false. */
function uniqueName(base, exists) {
    var name = base;
    for (var n = 2; n < 100 && exists(name); n++) name = base + " " + n;
    return name;
}

function fileExists(path) {
    return typeof host_file_exists === "function" && host_file_exists(path);
}

function showMessage(text, ticks) {
    touchedKnob = -1;
    overlayText = text;
    overlayTimer = ticks;
}

function exportFailed(text, spoken) {
    showMessage(text, EXPORT_MSG_TICKS);
    announce(spoken || text);
}

/* Write a Move drum rack preset that plays the slices from the sample. */
function exportDrumPreset(base) {
    var uri = sampleUriFor(filePath);
    if (!uri) {
        exportFailed("Not in User Library", "Export failed, sample is not in the User Library");
        return false;
    }
    if (typeof host_write_file !== "function") {
        exportFailed("Export failed");
        return false;
    }

    var name = uniqueName(base, function(n) { return fileExists(PRESET_DIR + "/" + n + ".ablpreset"); });
    var preset = buildDrumRackPreset({
        name: name,
        sampleUri: uri,
        frames: frames,
        starts: sliceStarts,
        ends: sliceEnds,
        env: { attackUs: attackUs, holdUs: holdUs, decayUs: decayUs, gated: gated },
        transpose: transpose,
        detune: detune,
        gainDb10: gainDb10,
        crushHz: crushHz,
        filter: { type: filterType, hz: filterHz10 / 10, res: filterRes / 1000, peakDb: filterPeakDb10 / 10 }
    });
    if (typeof host_ensure_dir === "function") host_ensure_dir(PRESET_DIR);
    var ok = host_write_file(PRESET_DIR + "/" + name + ".ablpreset", JSON.stringify(preset, null, 2));
    debugLog("export preset " + name + " ok=" + ok);
    if (ok === false) {
        exportFailed("Export failed");
        return false;
    }
    exportedVersion = editVersion;
    showMessage("Saved " + name, EXPORT_MSG_TICKS);
    announce("Exported drum rack, " + name);
    return true;
}

function readExportResult() {
    var p = (host_module_get_param("export_result") || "").split(" ");
    return { req: parseInt(p[0], 10) || 0, done: parseInt(p[1], 10) || 0, written: parseInt(p[2], 10) || 0 };
}

/* Write one WAV per slice into a new folder next to the sample:
 * "<name>/<name> 01.wav", ... The DSP worker writes them; pollSliceExport
 * reports the result. */
function exportSlices(base) {
    var dir = filePath.substring(0, filePath.lastIndexOf("/"));
    if (!dir) {
        exportFailed("Export failed");
        return false;
    }
    var name = uniqueName(base, function(n) { return fileExists(dir + "/" + n); });
    var folder = dir + "/" + name;
    if (typeof host_ensure_dir === "function" && host_ensure_dir(folder) === false) {
        exportFailed("Export failed", "Export failed, can't create folder");
        return false;
    }
    var before = readExportResult().req;
    setParamNow("export_slices", folder + "/" + name);
    sliceExport = { seq: before + 1, folder: name, version: editVersion, count: sliceCount, ticks: 0 };
    showMessage("Exporting...", SLICE_EXPORT_TIMEOUT_TICKS);
    announce("Exporting " + sliceCount + (sliceCount === 1 ? " slice" : " slices"));
    return true;
}

function pollSliceExport() {
    if (!sliceExport) return;
    var r = readExportResult();
    if (r.done < sliceExport.seq) {
        if (++sliceExport.ticks > SLICE_EXPORT_TIMEOUT_TICKS) {
            sliceExport = null;
            exportFailed("Export failed", "Export failed, timed out");
        }
        return;
    }
    var job = sliceExport;
    sliceExport = null;
    debugLog("export slices " + job.folder + " wrote " + r.written + "/" + job.count);
    if (r.written === job.count) {
        exportedVersion = job.version;
        showMessage("Saved " + job.folder, EXPORT_MSG_TICKS);
        announce("Exported " + r.written + (r.written === 1 ? " slice" : " slices") + " to " + job.folder);
    } else if (r.written > 0) {
        exportFailed("Saved " + r.written + " of " + job.count, "Export incomplete, saved " + r.written +
                     " of " + job.count + " slices");
    } else {
        exportFailed("Export failed");
    }
}

/* ============ Export menu ============ */

function openExportMenu() {
    if (loadState !== "ready" || sliceCount === 0) return;
    if (sliceExport) {
        announce("Still exporting");
        return;
    }
    if (convertJob) {
        announce("Still converting");
        return;
    }
    flushNudge();
    flushSettings();
    pollSlices();
    touchedKnob = -1;
    exportName = cleanName(fileName.replace(/\.wav$/i, "") + " Chop") || "Chop";
    exportIndex = 0;     /* the name row, like the waveform editor */
    exportMenu = true;
    announce("Export, " + exportName);
}

function exportMenuItem() {
    return exportIndex === 0 ? "Name, " + exportName : EXPORT_ACTIONS[exportIndex - 1];
}

function exportMenuMove(ticks) {
    if (ticks === 0) return;
    exportIndex = Math.max(0, Math.min(EXPORT_ACTIONS.length, exportIndex + (ticks > 0 ? 1 : -1)));
    announce(exportMenuItem());
}

function renameExport() {
    if (typeof host_open_text_entry !== "function") {
        showMessage("No keyboard", EXPORT_MSG_TICKS);
        announce("No keyboard");
        return;
    }
    host_open_text_entry({
        title: "Name",
        initialText: exportName,
        onConfirm: function(text) {
            var name = cleanName(text);
            if (name) exportName = name;
            announce("Name, " + exportName);
        },
        onCancel: function() {
            announce("Name, " + exportName);
        }
    });
}

function exportMenuChoose() {
    if (exportIndex === 0) {
        renameExport();
        return;
    }
    var action = EXPORT_ACTIONS[exportIndex - 1];
    exportMenu = false;
    if (action === "Slices") exportSlices(exportName);
    else if (action === "Drum Preset") exportDrumPreset(exportName);
    else announce("Cancelled");
}

/* While the export menu is up: jog chooses, jog click confirms, Back or
 * Record closes it. Everything else is ignored. */
function handleExportMenuCC(cc, value) {
    if (cc === CC_JOG) {
        exportMenuMove(decodeDelta(value));
    } else if (cc === CC_JOG_CLICK && value > 0) {
        exportMenuChoose();
    } else if ((cc === CC_BACK || cc === CC_RECORD) && value > 0) {
        exportMenu = false;
        announce("Cancelled");
    }
}

/* ============ Tools menu ============ */

function openMenu(m) {
    menu = m;
    announce((m.say || m.title) + ", " + m.items[m.index]);
}

/* While a list menu is up: jog chooses, jog click confirms, Back closes it
 * (or goes up a level). Everything else is ignored. */
function handleMenuCC(cc, value) {
    var m = menu;
    if (cc === CC_JOG) {
        var t = decodeDelta(value);
        if (t === 0) return;
        m.index = Math.max(0, Math.min(m.items.length - 1, m.index + (t > 0 ? 1 : -1)));
        announce(m.items[m.index]);
    } else if (cc === CC_JOG_CLICK && value > 0) {
        menu = null;
        m.choose(m.items[m.index]);
    } else if (cc === CC_BACK && value > 0) {
        menu = null;
        if (m.back) m.back();
        else announce("Closed");
    }
}

function openToolsMenu(index) {
    if (loadState !== "ready" || sliceCount === 0) return;
    if (sliceExport) {
        announce("Still exporting");
        return;
    }
    if (convertJob) {
        announce("Still converting");
        return;
    }
    flushNudge();
    flushSettings();
    touchedKnob = -1;
    openMenu({ title: "Tools", items: TOOLS_ITEMS, index: index || 0, choose: toolsChoose });
}

function toolsChoose(item) {
    if (item === "Normalize audio") normalizeGain();
    else if (item === "Channels") openChannelsMenu();
    else announce("Closed");
}

function openChannelsMenu() {
    if (host_module_get_param("channels") === "1") {
        showMessage("Already mono", EXPORT_MSG_TICKS);
        announce("Sample is already mono");
        return;
    }
    openMenu({ title: "Channels", items: CHANNEL_ITEMS, index: 0, choose: channelsChoose,
               back: function() { openToolsMenu(TOOLS_ITEMS.indexOf("Channels")); } });
}

/* Ask first: it replaces the file. Starts on No. */
function channelsChoose(item) {
    var c = CHANNEL_MODES[item];
    if (!c) {
        openToolsMenu(TOOLS_ITEMS.indexOf("Channels"));
        return;
    }
    openMenu({ title: c.ask, note: "Replaces the file", say: c.ask + " Replaces the file",
               items: ["Yes", "No"], index: 1,
               choose: function(answer) {
                   if (answer === "Yes") startConvert(c);
                   else announce("Cancelled");
               },
               back: function() { announce("Cancelled"); } });
}

function readConvertResult() {
    var p = (host_module_get_param("convert_result") || "").split(" ");
    return { req: parseInt(p[0], 10) || 0, done: parseInt(p[1], 10) || 0, status: parseInt(p[2], 10) || 0 };
}

/* Ask the DSP to rewrite the sample as 1 channel. It swaps the new audio
 * in under the same slices; pollConvert reports the result. */
function startConvert(c) {
    var before = readConvertResult().req;
    setParamNow("convert_channels", c.mode);
    convertJob = { seq: before + 1, c: c, ticks: 0 };
    showMessage("Converting...", CONVERT_TIMEOUT_TICKS);
    announce("Converting");
}

function pollConvert() {
    if (!convertJob) return;
    var job = convertJob;
    var r = readConvertResult();
    /* The DSP marks it done once the new audio is playing. */
    if (r.done < job.seq) {
        if (++job.ticks > CONVERT_TIMEOUT_TICKS) {
            convertJob = null;
            exportFailed("Convert failed", "Convert failed, timed out");
        }
        return;
    }
    convertJob = null;
    debugLog("convert " + job.c.mode + " " + filePath + " status=" + r.status);
    if (r.status === CONV_OK) {
        waveKey = "";           /* redraw the new waveform */
        editVersion++;          /* exported slices no longer match the file */
        showMessage(job.c.done, EXPORT_MSG_TICKS);
        announce(job.c.say);
    } else if (r.status === CONV_ALREADY_MONO) {
        exportFailed("Already mono", "Sample is already mono");
    } else if (r.status === CONV_LINKED) {
        exportFailed("File is hard-linked", "Convert failed, the file has other hard links");
    } else {
        exportFailed("Convert failed");
    }
}

/* Set Gain so the sample's peak is at 0 dBFS (the DSP found the peak when
 * it loaded the file). Nothing is written; the Gain knob takes it back. */
function normalizeGain() {
    var g = host_module_get_param("normalize_gain");
    if (g === "silent") {
        exportFailed("Sample is silent", "Sample is silent, nothing to normalize");
        return;
    }
    var v = parseInt(g, 10);
    if (isNaN(v)) {
        exportFailed("Normalize failed");
        return;
    }
    setGain(Math.max(GAIN_MIN, Math.min(GAIN_MAX, v)));
    showMessage("Gain: " + formatGain(gainDb10), EXPORT_MSG_TICKS);
    announce("Normalized, gain " + spokenGain(gainDb10));
}

/* ============ Exit ============ */

function hasUnexported() {
    return loadState === "ready" && editVersion !== exportedVersion;
}

function confirmItems() {
    return ["Keep for later", hasUnexported() ? "Discard and exit" : "Exit", "Cancel"];
}

function requestExit() {
    flushNudge();
    flushSettings();
    if (loadState !== "ready") {
        exitTool();
        return;
    }
    confirmExit = true;
    confirmIndex = CONFIRM_KEEP;
    announce((hasUnexported() ? "Not exported. " : "") + confirmItems()[confirmIndex]);
}

function confirmMove(ticks) {
    if (ticks === 0) return;
    var items = confirmItems();
    confirmIndex = Math.max(0, Math.min(items.length - 1, confirmIndex + (ticks > 0 ? 1 : -1)));
    announce(items[confirmIndex]);
}

function confirmChoose() {
    confirmExit = false;
    if (confirmIndex === CONFIRM_KEEP) {
        hideTool();
    } else if (confirmIndex === CONFIRM_EXIT) {
        exitTool();
    } else {
        announce("Cancelled");
    }
}

/* While the Back menu is up: jog chooses, jog click confirms, Back
 * cancels. Everything else is ignored. */
function handleConfirmCC(cc, value) {
    if (cc === CC_JOG) {
        confirmMove(decodeDelta(value));
    } else if (cc === CC_JOG_CLICK && value > 0) {
        confirmChoose();
    } else if (cc === CC_BACK && value > 0) {
        confirmExit = false;
        announce("Cancelled");
    }
}

/* ============ Resume ============ */

/* "3 <unexported> <zoom> <page> <length mode>". Version 2 stopped at zoom;
 * version 1 also had a waveform scale after it. */
function uiStateString() {
    return "3 " + (hasUnexported() ? 1 : 0) + " " + zoom + " " + page + " " + (lengthMode ? 1 : 0);
}

/* Keep the DSP's copy current, so a resume finds it however the tool was
 * left. Sent only when it changes. */
function saveUiState() {
    if (loadState !== "ready") return;
    var st = uiStateString();
    if (st === lastUiState) return;
    lastUiState = st;
    host_module_set_param("ui_state", st);
}

function restoreUiState() {
    var p = (host_module_get_param("ui_state") || "").split(" ");
    if (p[0] !== "1" && p[0] !== "2" && p[0] !== "3") return;
    if (p[1] === "1") {
        editVersion = 1;
        exportedVersion = 0;
    }
    var z = parseFloat(p[2]);
    if (z >= 0 && z <= ZOOM_MAX) zoom = z;
    if (p[0] === "3") {
        page = p[3] === "1" ? PAGE_FILTER : PAGE_MAIN;
        lengthMode = p[4] === "1";
    }
    lastUiState = uiStateString();
}

/* Hand the controls back to Move but leave the DSP running; Tools shows
 * "Resume: <file>" to come back to it. */
function hideTool() {
    flushNudge();
    flushSettings();
    saveUiState();
    setParamNow("stop", "1");
    if (typeof host_hide_module !== "function") {
        exitTool();
        return;
    }
    turnOffLeds();
    exited = true;
    announce("Kept for later, resume from Tools");
    host_hide_module();
}

/* ============ Announcements ============ */

function onLoadStateChange() {
    if (loadState === "ready") {
        zoom = 0;
        viewStart = 0;
        waveKey = "";
        page = PAGE_MAIN;
        lengthMode = false;
        readSettings();
        if (resumed) {
            restoreUiState();
            announce("Resumed " + fileName + ", " + sliceCount + (sliceCount === 1 ? " slice" : " slices"));
        } else {
            announce("Loaded " + fileName + ", press Pad 1");
        }
    } else if (loadState === "error") {
        errorMsg = host_module_get_param("error") || "Load failed";
        announce("Load failed, " + errorMsg);
    }
    debugLog("load state " + loadState);
}

function onChop() {
    if (sliceCount >= MAX_PADS) {
        announce("Chop, " + sliceCount + " slices, all pads used");
    } else {
        announce("Chop, " + sliceCount + " slices");
    }
}

function onDelete() {
    announce("Deleted, Pad " + (selectedSlice + 1) + " selected, " + sliceCount +
             (sliceCount === 1 ? " slice" : " slices"));
}

function onUndo() {
    announce("Undo, " + sliceCount + (sliceCount === 1 ? " slice" : " slices"));
}

function onRedo() {
    announce("Redo, " + sliceCount + (sliceCount === 1 ? " slice" : " slices"));
}

/* After a nudge settles: the start in seconds, or the length as Move shows it. */
function announceMarker() {
    var pad = "Pad " + (selectedSlice + 1);
    if (activeSide === 0) announce(pad + " start " + spokenSeconds(activeMarkerPos()));
    else announce(pad + " length " + formatPercent(lengthPercent()) + " percent");
}

/* ============ LEDs ============ */

function setButtonLit(cc, on) {
    if (buttonLedOn[cc] === on) return;
    buttonLedOn[cc] = on;
    if (cc === CC_RECORD) setButtonLED(cc, on ? White : Black);
    else setButtonLED(cc, on ? WhiteLedBright : WhiteLedOff);
}

/* Undo, Delete and Record are lit while pressing them would do something.
 * With Shift held, Undo shows whether there is anything to redo. Of Down /
 * Up, the one for the other knob page is lit. A knob's LED is lit while it
 * does something on this page, brighter the higher its value: knob_leds.mjs,
 * as the framework's own parameter pages do (Knobs 1-4 white, 5-8 amber). */
function updateButtonLeds() {
    if (exited) return;
    var ready = loadState === "ready";
    var editing = !confirmExit && !exportMenu && !menu;
    setButtonLit(CC_UNDO, (shiftHeld ? redoDepth : undoDepth) > 0 && editing);
    setButtonLit(CC_DELETE, ready && sliceCount > 1 && editing);
    setButtonLit(CC_RECORD, ready && sliceCount > 0 && editing && !sliceExport && !convertJob);
    setButtonLit(CC_DOWN, ready && editing && page === PAGE_MAIN);
    setButtonLit(CC_UP, ready && editing && page === PAGE_FILTER);
    var levels = [];
    for (var i = 0; i < 8; i++) levels.push(ready && sliceCount > 0 && editing ? knobLevel(i) : null);
    updateKnobLEDs(levels);
}

/* Set a slice pad's LED only when its color changes. */
function setPadColor(i, color) {
    if (padColors[i] === color) return;
    padColors[i] = color;
    setLED(padIndexToNote(i), color);
}

function updatePadLeds() {
    var ready = loadState === "ready";
    for (var i = 0; i < MAX_PADS; i++) {
        var color = COLOR_UNUSED;
        if (ready && i < sliceCount && (i === selectedSlice || (playing && i === playingSlice))) color = COLOR_PLAYING;
        else if (ready && i < sliceCount) color = COLOR_SLICE;
        else if (ready && i === sliceCount) color = COLOR_TARGET;
        setPadColor(i, color);
    }
}

function clearAllPadLeds() {
    for (var i = 0; i < MovePads.length; i++) setLED(MovePads[i], Black);
}

function turnOffLeds() {
    clearAllPadLeds();
    setButtonLit(CC_UNDO, false);
    setButtonLit(CC_DELETE, false);
    setButtonLit(CC_RECORD, false);
    setButtonLit(CC_DOWN, false);
    setButtonLit(CC_UP, false);
    clearKnobLEDs();
}

function exitTool() {
    flushNudge();
    flushSettings();
    turnOffLeds();
    exited = true;
    if (typeof host_exit_module === "function") host_exit_module();
}

/* ============ Drawing ============ */

/* A vertical line with a black gap either side, so it shows over the
 * waveform as well as over empty space. dashed: every other pixel. */
function drawMarkerLine(x, dashed) {
    if (x < WAVE_X || x >= WAVE_X + WAVE_COLS) return;
    if (x > 0) draw_line(x - 1, WAVE_TOP, x - 1, WAVE_BOT, 0);
    if (x < SCREEN_W - 1) draw_line(x + 1, WAVE_TOP, x + 1, WAVE_BOT, 0);
    if (dashed) {
        draw_line(x, WAVE_TOP, x, WAVE_BOT, 0);
        for (var y = WAVE_TOP; y <= WAVE_BOT; y += 2) set_pixel(x, y, 1);
    } else {
        draw_line(x, WAVE_TOP, x, WAVE_BOT, 1);
    }
}

/* Drawn at the level you hear: Gain scales it, and a boost flattens at the edges. */
function drawWaveform() {
    var gain = gainLinear(gainDb10);
    for (var c = 0; c < wavePeaks.length; c++) {
        var h = Math.min(WAVE_HALF, Math.round(wavePeaks[c] * gain * WAVE_HALF / 255));
        var x = WAVE_X + c;
        if (h > 0) draw_line(x, WAVE_MID - h, x, WAVE_MID + h, 1);
        else set_pixel(x, WAVE_MID, 1);
    }
}

function drawMarkers() {
    /* Other slices' chop points: dashed */
    for (var i = 0; i < sliceCount; i++) {
        if (i === selectedSlice || i === selectedSlice + 1) continue;
        drawMarkerLine(frameToX(sliceStarts[i]), true);
    }
    var last = sliceCount - 1;
    if (selectedSlice !== last) {
        drawMarkerLine(Math.min(frameToX(sliceEnds[last]), WAVE_X + WAVE_COLS - 1), true);
    }

    /* Selected slice: solid start and end, flag on each, bigger on active */
    var sx = frameToX(sliceStarts[selectedSlice]);
    var ex = Math.min(frameToX(sliceEnds[selectedSlice]), WAVE_X + WAVE_COLS - 1);
    drawMarkerLine(sx, false);
    drawMarkerLine(ex, false);
    var sFlag = activeSide === 0 ? 5 : 3;
    var eFlag = activeSide === 1 ? 5 : 3;
    if (sx >= WAVE_X && sx < WAVE_X + WAVE_COLS) fill_rect(sx, WAVE_TOP, sFlag, sFlag, 1);
    if (ex >= WAVE_X && ex < WAVE_X + WAVE_COLS) fill_rect(ex - eFlag + 1, WAVE_BOT - eFlag + 1, eFlag, eFlag, 1);

    if (playing) drawMarkerLine(frameToX(playPos), true);
}

function drawMinimap() {
    if (zoom <= 0 || frames <= 0) return;
    var x0 = WAVE_X + Math.floor(viewStart * WAVE_COLS / frames);
    var x1 = WAVE_X + Math.floor((viewStart + viewLen()) * WAVE_COLS / frames);
    draw_line(WAVE_X, MINIMAP_Y, WAVE_X + WAVE_COLS - 1, MINIMAP_Y, 1);
    fill_rect(x0, MINIMAP_Y - 1, Math.max(2, x1 - x0), 3, 1);
}

function drawEditor() {
    /* Zoom, transpose and marker values only show on the bottom line,
     * while their knob is touched or turned. */
    print(0, 0, "Pad " + (selectedSlice + 1) + "/" + sliceCount, 1);

    drawWaveform();
    drawMarkers();
    drawMinimap();

    if (overlayTimer > 0) {
        print(0, 54, overlayText, 1);
        return;
    }
    var len = sliceEnds[selectedSlice] - sliceStarts[selectedSlice];
    print(0, 54, "S " + formatSeconds(sliceStarts[selectedSlice], true) +
          " L " + formatSeconds(len, true), 1);
}

function drawConfirmExit() {
    print(2, 2, hasUnexported() ? "Not exported" : "Leave LiveChopper", 1);
    var items = confirmItems();
    for (var i = 0; i < items.length; i++) {
        var y = 18 + i * 12;
        if (i === confirmIndex) {
            fill_rect(0, y - 2, SCREEN_W, 11, 1);
            print(4, y, items[i], 0);
        } else {
            print(4, y, items[i], 1);
        }
    }
}

function drawExportMenu() {
    var title = "Export";
    print(Math.floor((SCREEN_W - text_width(title)) / 2), 2, title, 1);
    draw_line(0, 12, SCREEN_W - 1, 12, 1);
    var rows = [exportName.substring(0, 20)].concat(EXPORT_ACTIONS);
    for (var i = 0; i < rows.length; i++) {
        var y = 15 + i * 12;
        var x = i === 0 ? 2 : 8;     /* actions indented under the name */
        if (i === exportIndex) {
            fill_rect(0, y - 1, SCREEN_W, 11, 1);
            print(x, y + 1, rows[i], 0);
        } else {
            print(x, y + 1, rows[i], 1);
        }
    }
}

/* Title, a rule, an optional note line, then the rows with the chosen one
 * highlighted. */
function drawMenu(m) {
    var title = m.title, rows = m.items, index = m.index;
    print(Math.floor((SCREEN_W - text_width(title)) / 2), 2, title, 1);
    draw_line(0, 12, SCREEN_W - 1, 12, 1);
    var top = 15;
    if (m.note) {
        print(2, top + 1, m.note, 1);
        top += 14;
    }
    for (var i = 0; i < rows.length; i++) {
        var y = top + i * 12;
        if (i === index) {
            fill_rect(0, y - 1, SCREEN_W, 11, 1);
            print(4, y + 1, rows[i], 0);
        } else {
            print(4, y + 1, rows[i], 1);
        }
    }
}

function draw() {
    clear_screen();
    if (confirmExit) {
        drawConfirmExit();
        return;
    }
    if (exportMenu) {
        drawExportMenu();
        return;
    }
    if (menu) {
        drawMenu(menu);
        return;
    }
    if (loadState === "ready" && sliceCount > 0) {
        drawEditor();
        return;
    }
    print(2, 2, "LiveChopper", 1);
    print(2, 14, fileName ? fileName.substring(0, 20) : "(no file)", 1);
    if (loadState === "loading") print(2, 30, "Loading...", 1);
    else if (loadState === "error") print(2, 30, errorMsg.substring(0, 20), 1);
}

/* ============ Entry points ============ */

globalThis.init = function() {
    filePath = (typeof host_tool_file_path === "string") ? host_tool_file_path : "";
    fileName = baseName(filePath);
    clearAllPadLeds();
    /* knob_leds.mjs is shared: its cache may hold another UI's colours */
    resetKnobLedCache();
    /* Resuming a kept session: the DSP still has this file and its slices,
     * so don't reload it. If another tool replaced the DSP meanwhile, the
     * host still says "reconnect" but the file isn't there: load it fresh. */
    var reconnect = typeof host_tool_reconnect !== "undefined" && host_tool_reconnect;
    resumed = !!filePath && reconnect && host_module_get_param("file_path") === filePath;
    if (resumed) {
        debugLog("init resume file=" + filePath);
        return;
    }
    if (filePath) {
        if (typeof host_module_set_param_blocking === "function") {
            host_module_set_param_blocking("file_path", filePath, 10000);
        } else {
            host_module_set_param("file_path", filePath);
        }
    }
    debugLog("init file=" + filePath);
    announce("LiveChopper, loading " + (fileName || "no file"));
};

globalThis.tick = function() {
    flushNudge();
    flushSettings();
    pollStatus();
    pollSlices();
    pollSliceExport();
    pollConvert();
    if (!countsSynced) {
        /* A resumed DSP has counted edits already: adopt the counts without
         * announcing them or marking them unexported. */
        countsSynced = true;
        lastChopCount = chopCount;
        lastUndoCount = undoCount;
        lastRedoCount = redoCount;
        lastDeleteCount = deleteCount;
    }

    if (loadState !== lastLoadState) {
        lastLoadState = loadState;
        onLoadStateChange();
    }
    if (chopCount !== lastChopCount) {
        if (chopCount > lastChopCount) onChop();
        lastChopCount = chopCount;
        editVersion++;
    }
    if (undoCount !== lastUndoCount) {
        if (undoCount > lastUndoCount) onUndo();
        lastUndoCount = undoCount;
        editVersion++;
    }
    if (redoCount !== lastRedoCount) {
        if (redoCount > lastRedoCount) onRedo();
        lastRedoCount = redoCount;
        editVersion++;
    }
    if (deleteCount !== lastDeleteCount) {
        if (deleteCount > lastDeleteCount) onDelete();
        lastDeleteCount = deleteCount;
        editVersion++;
    }
    if (loadState === "ready" && sliceCount > 0) {
        var started = playing && playingSlice >= 0 && playingSlice !== lastPlayingSlice;
        lastPlayingSlice = playing ? playingSlice : -1;
        if (selectedSlice !== lastSelectedSlice || started) {
            lastSelectedSlice = selectedSlice;
            revealSlice();
        } else if (announceTimer > 0 && followMarker) {
            keepMarkerVisible();
        }
        clampView();
        refreshWave();
    }
    if (announceTimer > 0) {
        announceTimer--;
        if (announceTimer === 0) announceMarker();
    }
    if (settingAnnounceTimer > 0) {
        settingAnnounceTimer--;
        if (settingAnnounceTimer === 0) announce(settingAnnounce);
    }
    /* A touched knob keeps its readout up and live; it lingers after release. */
    if (touchedKnob >= 0 && loadState === "ready") {
        overlayText = knobReadout(touchedKnob)[0];
        overlayTimer = OVERLAY_TICKS;
    } else if (overlayTimer > 0) {
        overlayTimer--;
    }

    if (!exited) saveUiState();
    updatePadLeds();
    updateButtonLeds();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    var status = data[0] & 0xF0;
    var d1 = data[1];
    var d2 = data[2];

    /* Knob touch: notes 0-7, on = velocity 64+, off = lower or note-off.
     * Pads are handled by the DSP on the audio thread; nothing to do here. */
    if (status === 0x90 || status === 0x80) {
        if (d1 <= 7 && !confirmExit && !exportMenu && !menu) onKnobTouch(d1, status === 0x90 && d2 >= 64);
        return;
    }
    if (status !== 0xB0) return;

    if (d1 === CC_SHIFT) {
        shiftHeld = d2 > 0;
    } else if (confirmExit) {
        handleConfirmCC(d1, d2);
    } else if (exportMenu) {
        handleExportMenuCC(d1, d2);
    } else if (menu) {
        handleMenuCC(d1, d2);
    } else if (d1 === CC_JOG_CLICK && d2 > 0 && shiftHeld) {
        openToolsMenu();
    } else if (d1 === CC_BACK && d2 > 0) {
        requestExit();
    } else if (d1 === CC_RECORD && d2 > 0) {
        openExportMenu();
    } else if (d1 === CC_DELETE && d2 > 0) {
        deleteSelected();
    } else if (d1 === CC_UNDO && d2 > 0 && shiftHeld) {
        /* A pending nudge is a new edit, so it clears redo. */
        var nudged = pendingNudge && pendingNudge.delta !== 0;
        flushNudge();
        if (redoDepth > 0 && !nudged) setParamNow("redo", "1");
        else announce("Nothing to redo");
    } else if (d1 === CC_UNDO && d2 > 0) {
        flushNudge();
        if (undoDepth > 0) setParamNow("undo", "1");
        else announce("Nothing to undo");
    } else if (d1 >= CC_E1 && d1 <= CC_E8) {
        turnKnob(d1 - CC_E1, decodeDelta(d2));
    } else if ((d1 === CC_UP || d1 === CC_DOWN) && d2 > 0) {
        setPage(d1 === CC_DOWN ? PAGE_FILTER : PAGE_MAIN);
    } else if (d1 === CC_JOG) {
        queueNudge(0, decodeDelta(d2));     /* the jog only ever moves the start */
    } else if ((d1 === CC_LEFT || d1 === CC_RIGHT) && d2 > 0) {
        selectSlice(selectedSlice + (d1 === CC_LEFT ? -1 : 1));
    }
};
