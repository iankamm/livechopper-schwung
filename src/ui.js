/*
 * Chopper UI
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
 * Controls:
 *   Red pads   - Play that slice while held (chokes the others); selects it
 *   Blue pad   - While a slice plays: chop at the playhead
 *   Knob 1     - Move the selected slice's start
 *   Knob 2     - Move the selected slice's end
 *   Knob 3     - Zoom
 *   Knob 4     - Waveform vertical scale (1x-32x)
 *   Knob 5     - Attack (global, all slices)
 *   Knob 6     - Nothing for now
 *   Knob 7     - Decay: the fade after a pad is let go (global)
 *   Knob 8     - Transpose in semitones (global, repitch)
 *   Jog        - Move the selected slice's start
 *   Touch knob - Preview its value on the bottom line (and speak it)
 *   Shift      - Fine steps for knobs and jog
 *   Left/Right - Select previous/next slice
 *   Delete     - Delete the selected slice (merges it into the previous one)
 *   Undo       - Undo the last chop or delete  |  Shift+Undo: redo
 *   Mute       - Mute / unmute all audio on the device (Move and Chopper);
 *                lit while muted. Leaving Chopper always unmutes.
 *   Record     - Export menu: rename, Slices (one WAV per pad), Drum Preset
 *   Play       - Passed through to Move (module.json button_passthrough):
 *                plays/stops the set to practise along with
 *   Back       - Menu: Keep for later (hide; resume from Tools) / Discard
 *                and exit / Cancel
 */

import {
    MoveBack, MoveUndo, MoveRecord, MoveDelete, MoveMute, MoveShift, MoveLeft, MoveRight,
    MoveMainKnob, MoveMainButton, MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4,
    MoveKnob5, MoveKnob7, MoveKnob8,
    MovePads,
    Black, DarkGrey, White, BrightRed, PureBlue,
    WhiteLedOff, WhiteLedBright
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED, setButtonLED, decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { buildDrumRackPreset, sampleUriFor, PRESET_DIR } from './drum_rack.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("Chopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var CC_UNDO = MoveUndo;
var CC_RECORD = MoveRecord;      /* RGB LED */
var CC_MUTE = MoveMute;
var CC_DELETE = MoveDelete;
var CC_SHIFT = MoveShift;
var CC_LEFT = MoveLeft;
var CC_RIGHT = MoveRight;
var CC_JOG = MoveMainKnob;
var CC_JOG_CLICK = MoveMainButton;
var CC_E1 = MoveKnob1;
var CC_E2 = MoveKnob2;
var CC_E3 = MoveKnob3;
var CC_E4 = MoveKnob4;
var CC_E5 = MoveKnob5;
var CC_E7 = MoveKnob7;
var CC_E8 = MoveKnob8;

var PAD_NOTE_MIN = MovePads[0];
var MAX_PADS = 16;
var COLOR_SLICE = BrightRed;    /* playable slice pad */
var COLOR_PLAYING = White;      /* slice pad that is sounding */
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
var VSCALE_MIN = 1.0;
var VSCALE_MAX = 32.0;
var VSCALE_STEP = 0.25;

/* Envelope knobs move a 0-1 position; time = max * pos^3 for fine control
 * near zero. */
var ATTACK_MAX_US = 2000000;
var DECAY_MAX_US = 10000000;     /* Move's max; plays out like a one-shot */
var ENV_KNOB_STEP = 0.01;
var ENV_KNOB_FINE = 0.002;
var TRANSPOSE_MIN = -24;
var TRANSPOSE_MAX = 24;
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

/* Mute: silences the device's whole output (host_mute_move_audio). The
 * flag lives in the host and outlasts us, so every way out unmutes. */
var muted = false;

/* Export menu: row 0 is the name (click to rename), then the actions. */
var exportMenu = false;
var exportIndex = 0;
var exportName = "";
var EXPORT_ACTIONS = ["Slices", "Drum Preset", "Cancel"];
var sliceExport = null;     /* { seq, folder, version } while the DSP writes WAVs */
var SLICE_EXPORT_TIMEOUT_TICKS = 3000;
var lastSelectedSlice = -1;
var buttonLedOn = {};        /* last on/off sent per button CC */
var exited = false;         /* no LED updates once we have handed back */
var padColors = [];         /* last color sent per pad index, to avoid LED spam */

/* Editing */
var shiftHeld = false;
var activeSide = 0;         /* 0 = start marker, 1 = end marker */
var zoom = 0;
var viewStart = 0;
var pendingNudge = null;    /* { slice, side, delta } sent once per tick */
var announceTimer = 0;
var vScale = 1.0;

/* Global sound settings (DSP holds the truth; read back on load) */
var attackUs = 0;
var decayUs = DECAY_MAX_US;
var transpose = 0;
var attackKnob = 0;
var decayKnob = 1;
var pendingSettings = {};   /* key -> value, sent once per tick */
var overlayText = "";       /* footer readout while a sound knob moves */
var overlayTimer = 0;
var touchedKnob = -1;       /* 0-7 while a knob is touched */
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

function formatSeconds(f) {
    if (!sampleRate) return "0.000s";
    return (f / sampleRate).toFixed(3) + "s";
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

function queueNudge(side, ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    if (touchedKnob < 0) overlayTimer = 0;
    if (side !== activeSide) {
        activeSide = side;
        keepMarkerVisible();
    }
    var step = shiftHeld ? Math.max(1, Math.round(coarseStep() / FINE_DIVISOR)) : coarseStep();
    if (pendingNudge && (pendingNudge.slice !== selectedSlice || pendingNudge.side !== side)) {
        flushNudge();
    }
    if (!pendingNudge) pendingNudge = { slice: selectedSlice, side: side, delta: 0 };
    pendingNudge.delta += ticks * step;
    announceTimer = ANNOUNCE_SETTLE_TICKS;
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
    centerOn(activeMarkerPos());
    showKnob(2);
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
    if (us < 10000) return (us / 1000).toFixed(1) + "ms";
    if (us < 1000000) return Math.round(us / 1000) + "ms";
    return (us / 1000000).toFixed(2) + "s";
}

function spokenUs(us) {
    if (us < 1000000) return (Math.round(us / 100) / 10) + " milliseconds";
    return (Math.round(us / 10000) / 100) + " seconds";
}

function formatTranspose(t) {
    return (t > 0 ? "+" : "") + t + "st";
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
    decayUs = parseInt(p[1], 10) || 0;
    transpose = parseInt(p[2], 10) || 0;
    attackKnob = usToKnob(attackUs, ATTACK_MAX_US);
    decayKnob = usToKnob(decayUs, DECAY_MAX_US);
}

/* [screen text, spoken text] for knob i (0-7), from current values; null
 * for a knob with no job. */
function knobReadout(i) {
    switch (i) {
    case 0:
    case 1:
        var pos = sliceCount > 0 ? (i === 0 ? sliceStarts[selectedSlice] : sliceEnds[selectedSlice]) : 0;
        var name = i === 0 ? "Start" : "End";
        return [name + " " + formatSeconds(pos),
                "Pad " + (selectedSlice + 1) + " " + name.toLowerCase() + " " + spokenSeconds(pos)];
    case 2:
        var z = Math.round(Math.pow(2, zoom));
        return ["Zoom x" + z, "Zoom " + z];
    case 3:
        return ["Scale " + vScale.toFixed(1) + "x", "Scale " + vScale.toFixed(1)];
    case 4:
        return ["Attack " + formatUs(attackUs), "Attack " + spokenUs(attackUs)];
    case 5:
        return null;     /* Knob 6: Hold removed for now */
    case 6:
        return ["Decay " + formatUs(decayUs), "Decay " + spokenUs(decayUs)];
    default:
        return ["Transpose " + formatTranspose(transpose), "Transpose " + transpose + " semitones"];
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

function onKnobTouch(i, touched) {
    if (!touched) {
        if (touchedKnob === i) touchedKnob = -1;
        return;
    }
    if (loadState !== "ready" || !knobReadout(i)) return;
    touchedKnob = i;
    if (i <= 1 && activeSide !== i) {
        activeSide = i;
        keepMarkerVisible();
    }
    var r = knobReadout(i);
    overlayText = r[0];
    overlayTimer = OVERLAY_TICKS;
    announce(r[1]);
}

function clamp01(x) {
    return x < 0 ? 0 : (x > 1 ? 1 : x);
}

function changeSetting(cc, ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    var step = (shiftHeld ? ENV_KNOB_FINE : ENV_KNOB_STEP) * ticks;
    if (cc === CC_E5) {
        attackKnob = clamp01(attackKnob + step);
        attackUs = knobToUs(attackKnob, ATTACK_MAX_US);
        pendingSettings.attack_us = attackUs;
        showKnob(4);
    } else if (cc === CC_E7) {
        decayKnob = clamp01(decayKnob + step);
        decayUs = knobToUs(decayKnob, DECAY_MAX_US);
        pendingSettings.decay_us = decayUs;
        showKnob(6);
    } else if (cc === CC_E8) {
        transpose += ticks;
        if (transpose < TRANSPOSE_MIN) transpose = TRANSPOSE_MIN;
        if (transpose > TRANSPOSE_MAX) transpose = TRANSPOSE_MAX;
        pendingSettings.transpose = transpose;
        showKnob(7);
    }
}

function flushSettings() {
    for (var key in pendingSettings) {
        setParamNow(key, String(pendingSettings[key]));
        editVersion++;
    }
    pendingSettings = {};
}

function changeVScale(ticks) {
    if (loadState !== "ready" || ticks === 0) return;
    vScale *= Math.pow(2, ticks * VSCALE_STEP);
    if (vScale < VSCALE_MIN) vScale = VSCALE_MIN;
    if (vScale > VSCALE_MAX) vScale = VSCALE_MAX;
    if (vScale > 0.9 && vScale < 1.1) vScale = 1.0;
    showKnob(3);
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
        env: { attackUs: attackUs, decayUs: decayUs },
        transpose: transpose
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

/* "<version> <unexported> <zoom> <vScale>" */
function uiStateString() {
    return "1 " + (hasUnexported() ? 1 : 0) + " " + zoom + " " + vScale;
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
    if (p[0] !== "1") return;
    if (p[1] === "1") {
        editVersion = 1;
        exportedVersion = 0;
    }
    var z = parseFloat(p[2]);
    if (z >= 0 && z <= ZOOM_MAX) zoom = z;
    var v = parseFloat(p[3]);
    if (v >= VSCALE_MIN && v <= VSCALE_MAX) vScale = v;
    lastUiState = uiStateString();
}

/* Hand the controls back to Move but leave the DSP running; Tools shows
 * "Resume: <file>" to come back to it. */
function hideTool() {
    flushNudge();
    flushSettings();
    saveUiState();
    setParamNow("stop", "1");
    setMuted(false);
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

function announceMarker() {
    var name = activeSide === 0 ? " start " : " end ";
    announce("Pad " + (selectedSlice + 1) + name + spokenSeconds(activeMarkerPos()));
}

/* ============ LEDs ============ */

function setButtonLit(cc, on) {
    if (buttonLedOn[cc] === on) return;
    buttonLedOn[cc] = on;
    if (cc === CC_RECORD) setButtonLED(cc, on ? White : Black);
    else setButtonLED(cc, on ? WhiteLedBright : WhiteLedOff);
}

/* Undo, Delete and Record are lit while pressing them would do something.
 * With Shift held, Undo shows whether there is anything to redo. Mute is
 * lit while all audio is muted. */
function updateButtonLeds() {
    if (exited) return;
    var ready = loadState === "ready";
    var editing = !confirmExit && !exportMenu;
    setButtonLit(CC_UNDO, (shiftHeld ? redoDepth : undoDepth) > 0 && editing);
    setButtonLit(CC_DELETE, ready && sliceCount > 1 && editing);
    setButtonLit(CC_RECORD, ready && sliceCount > 0 && editing && !sliceExport);
    setButtonLit(CC_MUTE, muted);
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
        if (ready && playing && i === playingSlice) color = COLOR_PLAYING;
        else if (ready && i < sliceCount) color = COLOR_SLICE;
        else if (ready && i === sliceCount) color = COLOR_TARGET;
        setPadColor(i, color);
    }
}

function clearAllPadLeds() {
    for (var i = 0; i < MovePads.length; i++) setLED(MovePads[i], Black);
}

function setMuted(on) {
    muted = on;
    if (typeof host_mute_move_audio === "function") host_mute_move_audio(on ? 1 : 0);
}

function toggleMute() {
    if (typeof host_mute_move_audio !== "function") {
        showMessage("Mute unavailable", OVERLAY_TICKS);
        announce("Mute unavailable");
        return;
    }
    setMuted(!muted);
    showMessage(muted ? "Muted" : "Unmuted", OVERLAY_TICKS);
    announce(muted ? "All audio muted" : "Unmuted");
}

function turnOffLeds() {
    clearAllPadLeds();
    setButtonLit(CC_UNDO, false);
    setButtonLit(CC_DELETE, false);
    setButtonLit(CC_RECORD, false);
    setButtonLit(CC_MUTE, false);
}

function exitTool() {
    flushNudge();
    flushSettings();
    setMuted(false);
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

function drawWaveform() {
    for (var c = 0; c < wavePeaks.length; c++) {
        var h = Math.min(WAVE_HALF, Math.round(wavePeaks[c] * vScale * WAVE_HALF / 255));
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
    print(0, 54, (activeSide === 0 ? "S " : "E ") + formatSeconds(activeMarkerPos()) +
          " L " + formatSeconds(len), 1);
}

function drawConfirmExit() {
    print(2, 2, hasUnexported() ? "Not exported" : "Leave Chopper", 1);
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
    if (loadState === "ready" && sliceCount > 0) {
        drawEditor();
        return;
    }
    print(2, 2, "Chopper", 1);
    print(2, 14, fileName ? fileName.substring(0, 20) : "(no file)", 1);
    if (loadState === "loading") print(2, 30, "Loading...", 1);
    else if (loadState === "error") print(2, 30, errorMsg.substring(0, 20), 1);
}

/* ============ Entry points ============ */

globalThis.init = function() {
    filePath = (typeof host_tool_file_path === "string") ? host_tool_file_path : "";
    fileName = baseName(filePath);
    clearAllPadLeds();
    setMuted(false);        /* start audible, whatever was left behind */
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
    announce("Chopper, loading " + (fileName || "no file"));
};

globalThis.tick = function() {
    flushNudge();
    flushSettings();
    pollStatus();
    pollSlices();
    pollSliceExport();
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
        if (selectedSlice !== lastSelectedSlice) {
            lastSelectedSlice = selectedSlice;
            keepMarkerVisible();
        } else if (announceTimer > 0) {
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
        if (d1 <= 7 && !confirmExit && !exportMenu) onKnobTouch(d1, status === 0x90 && d2 >= 64);
        return;
    }
    if (status !== 0xB0) return;

    if (d1 === CC_SHIFT) {
        shiftHeld = d2 > 0;
    } else if (d1 === CC_MUTE && d2 > 0) {
        toggleMute();       /* works in menus too: a quick way to silence */
    } else if (confirmExit) {
        handleConfirmCC(d1, d2);
    } else if (exportMenu) {
        handleExportMenuCC(d1, d2);
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
    } else if (d1 === CC_E1) {
        queueNudge(0, decodeDelta(d2));
    } else if (d1 === CC_E2) {
        queueNudge(1, decodeDelta(d2));
    } else if (d1 === CC_E3) {
        changeZoom(decodeDelta(d2));
    } else if (d1 === CC_E4) {
        changeVScale(decodeDelta(d2));
    } else if (d1 === CC_E5 || d1 === CC_E7 || d1 === CC_E8) {
        changeSetting(d1, decodeDelta(d2));
    } else if (d1 === CC_JOG) {
        queueNudge(0, decodeDelta(d2));     /* the jog only ever moves the start */
    } else if ((d1 === CC_LEFT || d1 === CC_RIGHT) && d2 > 0) {
        selectSlice(selectedSlice + (d1 === CC_LEFT ? -1 : 1));
    }
};
