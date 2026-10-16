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
 *   Red pads   - Play that slice (one-shot, chokes the others); selects it
 *   Blue pad   - While a slice plays: chop at the playhead
 *   Knob 1     - Move the selected slice's start
 *   Knob 2     - Move the selected slice's end
 *   Knob 3     - Zoom
 *   Knob 4     - Waveform vertical scale (1x-32x)
 *   Knob 5-7   - Attack / Hold / Decay (global, all slices)
 *   Knob 8     - Transpose in semitones (global, repitch)
 *   Jog        - Move the active marker  |  Jog click: toggle start/end
 *   Touch knob - Preview its value on the bottom line (and speak it)
 *   Shift      - Fine steps for knobs and jog
 *   Left/Right - Select previous/next slice
 *   Undo       - Undo the last chop
 *   Back       - Exit
 */

import {
    MoveBack, MoveUndo, MoveShift, MoveLeft, MoveRight,
    MoveMainKnob, MoveMainButton, MoveKnob1, MoveKnob2, MoveKnob3, MoveKnob4,
    MoveKnob5, MoveKnob6, MoveKnob7, MoveKnob8,
    MovePads,
    Black, DarkGrey, White, BrightRed, PureBlue,
    WhiteLedOff, WhiteLedBright
} from '/data/UserData/schwung/shared/constants.mjs';

import { setLED, setButtonLED, decodeDelta } from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import { log as uniLog } from '/data/UserData/schwung/shared/logger.mjs';
function debugLog(msg) { uniLog("Chopper", msg); }

/* ============ Constants ============ */

var CC_BACK = MoveBack;
var CC_UNDO = MoveUndo;
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
var CC_E6 = MoveKnob6;
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

/* Vertical scale, as in the waveform editor: scale *= 2^step per tick. */
var VSCALE_MIN = 1.0;
var VSCALE_MAX = 32.0;
var VSCALE_STEP = 0.25;

/* Envelope knobs move a 0-1 position; time = max * pos^3 for fine control
 * near zero. Hold at the top of its range is Full (until the slice ends). */
var ATTACK_MAX_US = 2000000;
var HOLD_MAX_US = 5000000;
var DECAY_MAX_US = 10000000;
var HOLD_FULL = -1;
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
var playingSlice = -1;
var selectedSlice = 0;
var sliceCount = 0;
var sliceStarts = [];
var sliceEnds = [];

var lastLoadState = "";
var lastChopCount = 0;
var lastUndoCount = 0;
var lastSelectedSlice = -1;
var undoLedOn = null;
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
var holdUs = HOLD_FULL;
var decayUs = 50000;
var transpose = 0;
var attackKnob = 0;
var holdKnob = 1;
var decayKnob = 0;
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
    undoDepth = parseInt(p[2], 10) || 0;
    playingSlice = parseInt(p[3], 10);
    selectedSlice = parseInt(p[4], 10) || 0;
    sliceCount = parseInt(p[5], 10) || 0;
    sliceStarts = [];
    sliceEnds = [];
    for (var i = 0; i < sliceCount; i++) {
        sliceStarts.push(parseInt(p[6 + i * 2], 10) || 0);
        sliceEnds.push(parseInt(p[7 + i * 2], 10) || 0);
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
    if (us === HOLD_FULL) return "Full";
    if (us < 10000) return (us / 1000).toFixed(1) + "ms";
    if (us < 1000000) return Math.round(us / 1000) + "ms";
    return (us / 1000000).toFixed(2) + "s";
}

function spokenUs(us) {
    if (us === HOLD_FULL) return "full";
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
    holdUs = parseInt(p[1], 10);
    if (isNaN(holdUs)) holdUs = HOLD_FULL;
    decayUs = parseInt(p[2], 10) || 0;
    transpose = parseInt(p[3], 10) || 0;
    attackKnob = usToKnob(attackUs, ATTACK_MAX_US);
    holdKnob = holdUs === HOLD_FULL ? 1 : usToKnob(holdUs, HOLD_MAX_US);
    decayKnob = usToKnob(decayUs, DECAY_MAX_US);
}

/* [screen text, spoken text] for knob i (0-7), from current values. */
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
        return ["Hold " + formatUs(holdUs), "Hold " + spokenUs(holdUs)];
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
    if (loadState !== "ready") return;
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
    } else if (cc === CC_E6) {
        holdKnob = clamp01(holdKnob + step);
        holdUs = holdKnob >= 1 ? HOLD_FULL : knobToUs(holdKnob, HOLD_MAX_US);
        pendingSettings.hold_us = holdUs;
        showKnob(5);
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

/* ============ Announcements ============ */

function onLoadStateChange() {
    if (loadState === "ready") {
        announce("Loaded " + fileName + ", press Pad 1");
        zoom = 0;
        viewStart = 0;
        waveKey = "";
        readSettings();
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

function onUndo() {
    announce("Undo, " + sliceCount + (sliceCount === 1 ? " slice" : " slices"));
}

function announceMarker() {
    var name = activeSide === 0 ? " start " : " end ";
    announce("Pad " + (selectedSlice + 1) + name + spokenSeconds(activeMarkerPos()));
}

/* ============ LEDs ============ */

/* Undo button lit while there is a chop to undo. */
function updateUndoLed() {
    var on = undoDepth > 0;
    if (undoLedOn === on) return;
    undoLedOn = on;
    setButtonLED(CC_UNDO, on ? WhiteLedBright : WhiteLedOff);
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

function exitTool() {
    flushNudge();
    flushSettings();
    clearAllPadLeds();
    setButtonLED(CC_UNDO, WhiteLedOff);
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
    var header = "Pad " + (selectedSlice + 1) + "/" + sliceCount;
    header += activeSide === 0 ? "  START" : "  END";
    print(0, 0, header, 1);
    var zl = "x" + Math.round(Math.pow(2, zoom));
    if (transpose !== 0) zl = formatTranspose(transpose) + " " + zl;
    print(SCREEN_W - text_width(zl) - 1, 0, zl, 1);

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

function draw() {
    clear_screen();
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

    if (loadState !== lastLoadState) {
        lastLoadState = loadState;
        onLoadStateChange();
    }
    if (chopCount !== lastChopCount) {
        if (chopCount > lastChopCount) onChop();
        lastChopCount = chopCount;
    }
    if (undoCount !== lastUndoCount) {
        if (undoCount > lastUndoCount) onUndo();
        lastUndoCount = undoCount;
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

    updatePadLeds();
    updateUndoLed();
    draw();
};

globalThis.onMidiMessageInternal = function(data) {
    var status = data[0] & 0xF0;
    var d1 = data[1];
    var d2 = data[2];

    /* Knob touch: notes 0-7, on = velocity 64+, off = lower or note-off.
     * Pads are handled by the DSP on the audio thread; nothing to do here. */
    if (status === 0x90 || status === 0x80) {
        if (d1 <= 7) onKnobTouch(d1, status === 0x90 && d2 >= 64);
        return;
    }
    if (status !== 0xB0) return;

    if (d1 === CC_SHIFT) {
        shiftHeld = d2 > 0;
    } else if (d1 === CC_BACK && d2 > 0) {
        exitTool();
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
    } else if (d1 === CC_E5 || d1 === CC_E6 || d1 === CC_E7 || d1 === CC_E8) {
        changeSetting(d1, decodeDelta(d2));
    } else if (d1 === CC_JOG) {
        queueNudge(activeSide, decodeDelta(d2));
    } else if (d1 === CC_JOG_CLICK && d2 > 0) {
        activeSide = 1 - activeSide;
        keepMarkerVisible();
        announce("Pad " + (selectedSlice + 1) + (activeSide === 0 ? " start" : " end"));
    } else if ((d1 === CC_LEFT || d1 === CC_RIGHT) && d2 > 0) {
        selectSlice(selectedSlice + (d1 === CC_LEFT ? -1 : 1));
    }
};
