/*
 * Host-side test for src/dsp/plugin.c: compiles the plugin in, loads WAVs
 * through the real worker thread, and drives pads/params like the host.
 *
 *   gcc -std=c11 -g -fsanitize=address,undefined -Isrc/dsp \
 *       tests/dsp_test.c -o build/dsp_test -lm -lpthread && build/dsp_test
 */
#define LIVE_CHOPPER_TEST
#include "../src/dsp/plugin.c"

#include <math.h>
#include <unistd.h>
#include <sys/stat.h>

static int failures = 0;
#define CHECK(cond, ...) do { if (!(cond)) { failures++; printf("FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static plugin_api_v2_t *api;
static int16_t out[MOVE_FRAMES_PER_BLOCK * 2];

static void wr16(FILE *f, int v) { fputc(v & 255, f); fputc((v >> 8) & 255, f); }
static void wr32(FILE *f, int v) { wr16(f, v & 0xFFFF); wr16(f, (v >> 16) & 0xFFFF); }

/* Ramp WAV: sample i of channel c = (i * 3 + c * 1000) % 30000, scaled to bits. */
static void write_wav(const char *path, int frames, int channels, int rate, int bits) {
    FILE *f = fopen(path, "wb");
    int bps = bits / 8, data = frames * channels * bps;
    fwrite("RIFF", 1, 4, f); wr32(f, 36 + data); fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f); wr32(f, 16); wr16(f, 1); wr16(f, channels);
    wr32(f, rate); wr32(f, rate * channels * bps); wr16(f, channels * bps); wr16(f, bits);
    fwrite("data", 1, 4, f); wr32(f, data);
    for (int i = 0; i < frames; i++) {
        for (int c = 0; c < channels; c++) {
            int v = (i * 3 + c * 1000) % 30000;
            if (bits == 16) wr16(f, v);
            else { fputc(0x5A, f); wr16(f, v); }   /* 24-bit: low byte is noise */
        }
    }
    fclose(f);
}

static uint8_t *read_file(const char *path, long *len) {
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    *len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t *b = malloc((size_t)*len);
    if (fread(b, 1, (size_t)*len, f) != (size_t)*len) *len = -1;
    fclose(f);
    return b;
}

/* Sine WAV at `amp` of full scale: fmt 1 = PCM, 3 = float. Channel c is
 * phase-shifted so the channels differ. amp 0 writes silence. */
static void write_sine(const char *path, int frames, int channels, int bits, int fmt, double amp) {
    FILE *f = fopen(path, "wb");
    int bps = bits / 8, data = frames * channels * bps;
    fwrite("RIFF", 1, 4, f); wr32(f, 36 + data); fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f); wr32(f, 16); wr16(f, fmt); wr16(f, channels);
    wr32(f, 44100); wr32(f, 44100 * channels * bps); wr16(f, channels * bps); wr16(f, bits);
    fwrite("data", 1, 4, f); wr32(f, data);
    uint8_t b[8];
    for (int i = 0; i < frames; i++) {
        for (int c = 0; c < channels; c++) {
            write_native(b, amp * sin(i * 0.05 + c), fmt, bits);
            fwrite(b, 1, (size_t)bps, f);
        }
    }
    fclose(f);
}

/* Largest |sample| in a canonical 44-byte-header WAV, as a fraction of full scale. */
static double file_peak(const char *path, int fmt, int bits) {
    long len = 0;
    uint8_t *b = read_file(path, &len);
    double peak = -1;
    if (b && len > 44) {
        peak = 0;
        for (long i = 44; i + bits / 8 <= len; i += bits / 8) {
            double v = fabs(read_native(b + i, fmt, bits));
            if (v > peak) peak = v;
        }
    }
    free(b);
    return peak;
}

static int ramp(int i, int c) { return (i * 3 + c * 1000) % 30000; }

static void render(void *inst, int blocks) {
    for (int b = 0; b < blocks; b++) api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
}

static void note(void *inst, int n) {
    uint8_t m[3] = { 0x90, (uint8_t)n, 100 };
    api->on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL);
}

static void note_off(void *inst, int n) {
    uint8_t m[3] = { 0x80, (uint8_t)n, 0 };
    api->on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL);
}

static void param(void *inst, const char *k, const char *v) { api->set_param(inst, k, v); }

static void get(void *inst, const char *k, char *buf, int len) {
    if (api->get_param(inst, k, buf, len) < 0) buf[0] = 0;
}

static void *load(const char *path) {
    void *inst = api->create_instance(".", NULL);
    param(inst, "file_path", path);
    char st[256];
    for (int t = 0; t < 400; t++) {
        render(inst, 1);
        get(inst, "status", st, sizeof st);
        if (strncmp(st, "ready", 5) == 0 || strncmp(st, "error", 5) == 0) break;
        usleep(5000);
    }
    return inst;
}

/* Ask for a channel conversion and wait until it is done (swapped in, when
 * it worked). Returns the status. */
static int convert(void *inst, const char *mode) {
    char res[64];
    unsigned req = 0, r = 0, d = 0;
    int status = -1;
    get(inst, "convert_result", res, sizeof res);
    sscanf(res, "%u", &req);
    param(inst, "convert_channels", mode);
    for (int t = 0; t < 400; t++) {
        render(inst, 1);
        get(inst, "convert_result", res, sizeof res);
        sscanf(res, "%u %u %d", &r, &d, &status);
        if (d == req + 1) return status;
        usleep(5000);
    }
    return -1;
}

static int exists(const char *path) { return access(path, F_OK) == 0; }

/* Slices as "count:s-e,s-e,..." */
static const char *slices(void *inst) {
    static char res[512];
    char raw[1024];
    get(inst, "slices", raw, sizeof raw);
    unsigned chop, undo, del, redo; int depth, redo_depth, playing, sel, count;
    int n = 0, off = 0;
    sscanf(raw, "%u %u %u %d %u %d %d %d %d%n", &chop, &undo, &del, &depth, &redo, &redo_depth,
           &playing, &sel, &count, &off);
    n = snprintf(res, sizeof res, "%d:", count);
    const char *p = raw + off;
    for (int i = 0; i < count; i++) {
        int s, e, used;
        sscanf(p, "%d %d%n", &s, &e, &used);
        p += used;
        n += snprintf(res + n, sizeof res - (size_t)n, "%s%d-%d", i ? "," : "", s, e);
    }
    return res;
}

static int field(void *inst, int i) {
    char raw[1024];
    get(inst, "slices", raw, sizeof raw);
    const char *p = raw;
    int v = 0;
    for (int k = 0; k <= i; k++) v = parse_int(&p);
    return v;
}
#define F_UNDO_DEPTH 3
#define F_REDO_DEPTH 5
#define F_PLAYING 6
#define F_SELECTED 7

/* Render until nothing is playing (and the choke tail is gone). */
static void until_silent(void *inst) {
    for (int i = 0; i < 2000 && field(inst, F_PLAYING) != -1; i++) render(inst, 1);
    render(inst, 1);
}

int main(void) {
    api = move_plugin_init_v2(NULL);
    mkdir("build", 0755);
    write_wav("build/t16.wav", 44100, 1, 44100, 16);
    write_wav("build/t24.wav", 4800, 2, 48000, 24);

    /* ---- Load + plain playback ---- */
    void *inst = load("build/t16.wav");
    char st[256];
    get(inst, "status", st, sizeof st);
    CHECK(strncmp(st, "ready 44100 44100", 17) == 0, "status after load: %s", st);
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "initial slices %s", slices(inst));

    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    int exact = 1;
    for (int i = 0; i < MOVE_FRAMES_PER_BLOCK; i++)
        if (out[i * 2] != ramp(i, 0) || out[i * 2 + 1] != ramp(i, 0)) exact = 0;
    CHECK(exact, "mono 16-bit plays back sample-exact on both channels");

    /* ---- Chop at the playhead: block-accurate ---- */
    render(inst, 9);                       /* playhead at 10 blocks = 1280 */
    note(inst, 69);                        /* Pad 2 is blue */
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "first chop %s", slices(inst));
    CHECK(field(inst, F_PLAYING) == 1 && field(inst, F_SELECTED) == 1, "playback moved to new slice");
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == ramp(1280, 0), "playback continues seamlessly at the chop: %d vs %d", out[0], ramp(1280, 0));

    /* ---- Middle split (spec example) ---- */
    note(inst, 68); render(inst, 5);       /* Pad 1 at 640 */
    note(inst, 70);                        /* Pad 3 is blue */
    CHECK(strcmp(slices(inst), "3:0-640,640-1280,1280-44100") == 0, "middle split %s", slices(inst));
    CHECK(field(inst, F_PLAYING) == 1, "plays the new Pad 2");

    /* Blue pad while silent does nothing; pads past blue do nothing */
    render(inst, 50);
    note(inst, 71);
    CHECK(strcmp(slices(inst), "3:0-640,640-1280,1280-44100") == 0, "blue pad while silent");

    /* ---- Undo ---- */
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "undo %s", slices(inst));
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "undo to start %s", slices(inst));
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "undo with nothing left");

    /* ---- Delete merges into previous ---- */
    note(inst, 68); render(inst, 10); note(inst, 69);      /* 0-1280 | 1280-end */
    note(inst, 69); render(inst, 10); note(inst, 70);      /* 1280-2560 | 2560-end */
    CHECK(strcmp(slices(inst), "3:0-1280,1280-2560,2560-44100") == 0, "setup for delete %s", slices(inst));
    param(inst, "delete", "1");
    CHECK(strcmp(slices(inst), "2:0-2560,2560-44100") == 0, "delete Pad 2 merges into Pad 1: %s", slices(inst));
    CHECK(field(inst, F_SELECTED) == 0, "selection moves to the merged pad");
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "3:0-1280,1280-2560,2560-44100") == 0, "undo delete %s", slices(inst));
    param(inst, "delete", "0");
    CHECK(strcmp(slices(inst), "2:1280-2560,2560-44100") == 0, "delete Pad 1 trims it, Pad 2 becomes Pad 1: %s", slices(inst));
    CHECK(field(inst, F_SELECTED) == 0, "Pad 1 still selected after deleting it");
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "3:0-1280,1280-2560,2560-44100") == 0, "undo Pad 1 delete %s", slices(inst));
    param(inst, "delete", "1");
    param(inst, "delete", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "delete down to one %s", slices(inst));
    param(inst, "delete", "0");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "can't delete the only slice");

    /* Delete Pad 1 while it plays: its audio is gone, so it stops */
    note(inst, 68); render(inst, 10); note(inst, 69);
    note(inst, 68); render(inst, 2);
    param(inst, "delete", "0");
    CHECK(field(inst, F_PLAYING) == -1, "deleting playing Pad 1 stops it (got %d)", field(inst, F_PLAYING));
    param(inst, "undo", "1");
    param(inst, "delete", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "back to one slice %s", slices(inst));

    /* Delete the playing slice: playback continues in the merged slice */
    note(inst, 68); render(inst, 10); note(inst, 69);
    render(inst, 2);
    param(inst, "delete", "1");
    CHECK(field(inst, F_PLAYING) == 0, "playing slice deleted: plays on in merged Pad 1");

    /* ---- Redo ---- */
    note(inst, 68); render(inst, 10); note(inst, 69);      /* 0-1280 | 1280-end */
    param(inst, "delete", "0");                            /* 1280-end */
    CHECK(strcmp(slices(inst), "1:1280-44100") == 0, "setup for redo %s", slices(inst));
    CHECK(field(inst, F_REDO_DEPTH) == 0, "nothing to redo yet");
    param(inst, "redo", "1");
    CHECK(strcmp(slices(inst), "1:1280-44100") == 0, "redo with nothing to redo %s", slices(inst));
    param(inst, "undo", "1");
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "two undos %s", slices(inst));
    CHECK(field(inst, F_REDO_DEPTH) == 2, "two redos available");
    param(inst, "redo", "1");
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "redo the chop %s", slices(inst));
    param(inst, "redo", "1");
    CHECK(strcmp(slices(inst), "1:1280-44100") == 0, "redo the delete %s", slices(inst));
    CHECK(field(inst, F_REDO_DEPTH) == 0, "redo stack used up");
    param(inst, "undo", "1");
    CHECK(strcmp(slices(inst), "2:0-1280,1280-44100") == 0, "undo after redo %s", slices(inst));
    param(inst, "nudge", "1 1 -10");
    CHECK(field(inst, F_REDO_DEPTH) == 0, "a nudge clears redo");
    param(inst, "undo", "1");                              /* back to 1:0-44100 */
    param(inst, "delete", "0");                            /* nothing to delete: no new edit */
    CHECK(field(inst, F_REDO_DEPTH) == 1, "a refused delete keeps redo");
    note(inst, 68); render(inst, 10); note(inst, 69);
    CHECK(field(inst, F_REDO_DEPTH) == 0, "a chop clears redo");
    param(inst, "delete", "1");
    CHECK(strcmp(slices(inst), "1:0-44100") == 0, "back to one slice %s", slices(inst));
    until_silent(inst);

    /* ---- Undo history is bounded and keeps working past 32 steps ---- */
    for (int i = 0; i < 40; i++) {
        note(inst, 68); render(inst, 3); note(inst, 69);
        param(inst, "delete", "1");
    }
    int undos = 0;
    for (int i = 0; i < 100 && field(inst, F_UNDO_DEPTH) > 0; i++) { param(inst, "undo", "1"); undos++; }
    CHECK(undos == 32, "undo history holds 32 steps (got %d)", undos);

    /* ---- Linked nudge ---- */
    api->destroy_instance(inst);
    inst = load("build/t16.wav");
    note(inst, 68); render(inst, 10); note(inst, 69);
    param(inst, "nudge", "1 0 100");
    CHECK(strcmp(slices(inst), "2:0-1380,1380-44100") == 0, "nudge start moves previous end %s", slices(inst));
    param(inst, "nudge", "0 1 -2000");
    CHECK(strcmp(slices(inst), "2:0-64,64-44100") == 0, "nudge clamps at min length %s", slices(inst));
    param(inst, "nudge", "0 0 500");
    CHECK(strcmp(slices(inst), "2:0-64,64-44100") == 0, "can't push start past end %s", slices(inst));
    param(inst, "nudge", "1 1 -100");
    CHECK(strcmp(slices(inst), "2:0-64,64-44000") == 0, "trim last end %s", slices(inst));

    /* ---- Transpose +12 plays at double speed ---- */
    param(inst, "transpose", "12");
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[2] == ramp(2, 0) && out[4] == ramp(4, 0), "transpose +12 reads every other frame (%d %d %d, want %d %d %d; %s)", out[0], out[2], out[4], ramp(0,0), ramp(2,0), ramp(4,0), slices(inst));
    param(inst, "transpose", "0");

    /* ---- Detune: cents on top of transpose, clamped to +-50 ---- */
    param(inst, "detune", "999");           /* clamps to +50: ratio 2^(50/1200) */
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(abs(out[80] - 124) <= 1, "detune +50 cents reads 40 frames as 41.17 (%d, want ~124)", out[80]);
    char det[64];
    get(inst, "settings", det, sizeof det);
    int d6 = 0;
    sscanf(det, "%*d %*d %*d %*d %*d %d", &d6);
    CHECK(d6 == 50, "detune clamped and reported: %s", det);
    param(inst, "detune", "-50");
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(abs(out[80] - 117) <= 1, "detune -50 cents reads 40 frames as 38.86 (%d, want ~117)", out[80]);
    param(inst, "detune", "0");

    /* ---- Envelope: attack ramps, hold/decay end the voice ---- */
    param(inst, "nudge", "0 1 20000");      /* Pad 1 = 0-20064 */
    param(inst, "attack_us", "10000");      /* 441 frames */
    until_silent(inst);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == 0 && abs(out[200] - ramp(100, 0) * 100 / 441) <= 1, "attack ramps from 0 (%d)", out[200]);
    param(inst, "attack_us", "0");
    param(inst, "hold_us", "10000");
    param(inst, "decay_us", "10000");
    note(inst, 68);
    render(inst, 8);                        /* 1024 frames > 441 + 441 */
    CHECK(field(inst, F_PLAYING) == -1, "voice ends after hold + decay");
    param(inst, "hold_us", "-1");

    /* ---- Gated (A-S-R): plays while held, Decay is the release ---- */
    char set[64];
    get(inst, "settings", set, sizeof set);
    CHECK(strcmp(set, "0 -1 10000 0 0 0 0") == 0, "one-shot by default: %s", set);
    note(inst, 68); render(inst, 2);
    note_off(inst, 68); render(inst, 20);
    CHECK(field(inst, F_PLAYING) == 0, "one-shot ignores the pad being let go");
    param(inst, "gate", "1");               /* pad already let go: release now */
    render(inst, 5);
    CHECK(field(inst, F_PLAYING) == -1, "switching to gated after letting go releases");
    get(inst, "settings", set, sizeof set);
    CHECK(strcmp(set, "0 -1 10000 0 1 0 0") == 0, "gated reported: %s", set);
    param(inst, "hold_us", "10000");        /* Hold does nothing when gated */
    note(inst, 68); render(inst, 20);       /* 2560 frames > hold + decay */
    CHECK(field(inst, F_PLAYING) == 0, "gated sustains while held, ignoring Hold");
    note_off(inst, 69);
    render(inst, 5);
    CHECK(field(inst, F_PLAYING) == 0, "letting go of another pad doesn't release");
    note(inst, 69); render(inst, 2);        /* blue pad: chop while held */
    CHECK(field(inst, F_PLAYING) == 1, "chop while held carries on into Pad 2");
    note_off(inst, 69); render(inst, 2);
    CHECK(field(inst, F_PLAYING) == 1, "letting go of the blue pad keeps the gate");
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    int before = abs(out[254]);
    note_off(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(abs(out[254]) < before, "release fades (%d -> %d)", before, abs(out[254]));
    render(inst, 4);                        /* 441-frame release */
    CHECK(field(inst, F_PLAYING) == -1, "voice ends after the release");
    note(inst, 68); render(inst, 2);
    uint8_t off0[3] = { 0x90, 68, 0 };      /* note-on velocity 0 = note-off */
    api->on_midi(inst, off0, 3, MOVE_MIDI_SOURCE_INTERNAL);
    render(inst, 5);
    CHECK(field(inst, F_PLAYING) == -1, "velocity-0 note-on releases too");
    param(inst, "delete", "1");             /* undo the chop */
    param(inst, "gate", "0");
    param(inst, "hold_us", "-1");

    /* ---- Resume support: ui_state round-trips, stop silences ---- */
    get(inst, "ui_state", set, sizeof set);
    CHECK(set[0] == 0, "ui_state starts empty");
    param(inst, "ui_state", "1 1 3.5 2.0");
    get(inst, "ui_state", set, sizeof set);
    CHECK(strcmp(set, "1 1 3.5 2.0") == 0, "ui_state kept: %s", set);
    char longv[300];
    memset(longv, 'x', sizeof longv - 1); longv[sizeof longv - 1] = 0;
    param(inst, "ui_state", longv);
    get(inst, "ui_state", set, sizeof set);
    CHECK(strlen(set) == sizeof set - 1, "long ui_state truncated safely");
    note(inst, 68); render(inst, 2);
    param(inst, "stop", "1");
    CHECK(field(inst, F_PLAYING) == -1, "stop ends the voice");
    render(inst, 2);

    /* ---- Choke fades the old voice instead of cutting it ---- */
    note(inst, 68); render(inst, 4);
    note(inst, 69);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] != ramp(20064, 0), "choke mixes in a fading tail");
    api->destroy_instance(inst);

    /* ---- 24-bit stereo 48 kHz ---- */
    inst = load("build/t24.wav");
    get(inst, "status", st, sizeof st);
    CHECK(strncmp(st, "ready 4800 48000", 16) == 0, "24-bit stereo status %s", st);
    note(inst, 68);
    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
    CHECK(out[0] == ramp(0, 0) && out[1] == ramp(0, 1), "24-bit stereo decodes L/R (%d %d)", out[0], out[1]);

    /* ---- Slice export copies source frames as they are ---- */
    render(inst, 10); note(inst, 69);       /* chop: Pad 1 | Pad 2 */
    int cut = field(inst, 10);              /* end of Pad 1 */
    CHECK(strncmp(slices(inst), "2:0-", 4) == 0, "export setup %s", slices(inst));
    mkdir("build/exp", 0755);
    remove("build/exp/t24 01.wav"); remove("build/exp/t24 02.wav");
    get(inst, "export_result", st, sizeof st);
    CHECK(strcmp(st, "0 0 0") == 0, "no export yet: %s", st);
    param(inst, "export_slices", "build/exp/t24");
    for (int t = 0; t < 400; t++) {
        get(inst, "export_result", st, sizeof st);
        if (strcmp(st, "1 1 2") == 0) break;
        usleep(5000);
    }
    CHECK(strcmp(st, "1 1 2") == 0, "export finished with 2 slices: %s", st);
    long src_len = 0, len1 = 0, len2 = 0;
    uint8_t *src = read_file("build/t24.wav", &src_len);
    uint8_t *w1 = read_file("build/exp/t24 01.wav", &len1);
    uint8_t *w2 = read_file("build/exp/t24 02.wav", &len2);
    int ba = 6;                             /* 24-bit stereo */
    CHECK(w1 && len1 == 44 + (long)cut * ba, "slice 1 size %ld (cut %d)", len1, cut);
    CHECK(w2 && len2 == 44 + (long)(4800 - cut) * ba, "slice 2 size %ld", len2);
    if (src && w1 && w2 && len1 > 44 && len2 > 44) {
        CHECK(memcmp(w1, src, 4) == 0 && memcmp(w1 + 8, src + 8, 28) == 0, "slice 1 keeps the fmt chunk");
        CHECK(rd_u32(w1 + 4) == (uint32_t)(len1 - 8) && rd_u32(w1 + 40) == (uint32_t)(len1 - 44), "slice 1 sizes in header");
        CHECK(memcmp(w1 + 44, src + 44, (size_t)(len1 - 44)) == 0, "slice 1 audio is the source's first frames");
        CHECK(memcmp(w2 + 44, src + 44 + (long)cut * ba, (size_t)(len2 - 44)) == 0, "slice 2 audio follows on");
    }
    free(src); free(w1); free(w2);
    param(inst, "export_slices", "build/no-such-dir/t24");
    for (int t = 0; t < 400; t++) {
        get(inst, "export_result", st, sizeof st);
        if (strncmp(st, "2 2", 3) == 0) break;
        usleep(5000);
    }
    CHECK(strcmp(st, "2 2 0") == 0, "export to a missing folder writes nothing: %s", st);
    api->destroy_instance(inst);

    /* ---- Gain: applied to playback, ramped, in the settings ---- */
    {
        write_sine("build/g16.wav", 20000, 1, 16, 1, 0.25);
        inst = load("build/g16.wav");
        note(inst, 68); render(inst, 1);                    /* past the first block */
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int16_t ref[MOVE_FRAMES_PER_BLOCK * 2];
        memcpy(ref, out, sizeof ref);
        until_silent(inst);
        param(inst, "gain_db10", "60");                     /* +6.0 dB = x1.995 */
        note(inst, 68); render(inst, 1);
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int worst = 0;
        for (int i = 0; i < MOVE_FRAMES_PER_BLOCK * 2; i++) {
            int e = abs(out[i] - (int)lrint(ref[i] * pow(10, 0.3)));
            if (e > worst) worst = e;
        }
        CHECK(worst <= 2, "+6 dB scales playback (worst error %d)", worst);
        char set[64];
        get(inst, "settings", set, sizeof set);
        CHECK(strcmp(set + strlen(set) - 3, " 60") == 0, "gain is settings field 7: %s", set);

        /* A change mid-note ramps over one block, never past either end */
        param(inst, "gain_db10", "0");
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int over = 0;
        for (int i = 0; i < MOVE_FRAMES_PER_BLOCK; i++) {
            /* this block reads the frames after ref's block; bound by |sample| * 2 */
            if (abs(out[i * 2]) > 2 * 8192 + 2) over++;
        }
        CHECK(over == 0, "gain ramp stays within range (%d over)", over);
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int16_t want = (int16_t)lrint(0.25 * 32768 * sin((3 * MOVE_FRAMES_PER_BLOCK + 10) * 0.05));
        CHECK(abs(out[20] - want) <= 1, "after the ramp gain is unity (%d, want %d)", out[20], want);

        param(inst, "gain_db10", "-1000");                  /* clamps to -70 dB, Move's floor */
        get(inst, "settings", set, sizeof set);
        CHECK(strcmp(set + strlen(set) - 5, " -700") == 0, "gain clamps at -70 dB: %s", set);
        render(inst, 1);
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int peak = 0;
        for (int i = 0; i < MOVE_FRAMES_PER_BLOCK * 2; i++) if (abs(out[i]) > peak) peak = abs(out[i]);
        CHECK(peak <= 3, "-70 dB is all but silent (peak %d of 8192)", peak);
        param(inst, "gain_db10", "999");
        get(inst, "settings", set, sizeof set);
        CHECK(strcmp(set + strlen(set) - 4, " 240") == 0, "gain clamps at +24 dB: %s", set);
        param(inst, "gain_db10", "0");
        api->destroy_instance(inst);
    }

    /* ---- normalize_gain: the gain that puts the peak at 0 dBFS ---- */
    {
        struct { const char *path; int ch, bits, fmt; double amp; } cases[] = {
            { "build/n16.wav", 1, 16, 1, 0.25 },
            { "build/n24.wav", 2, 24, 1, 0.25 },
            { "build/nf32.wav", 2, 32, 3, 0.25 },
            { "build/nf32hot.wav", 1, 32, 3, 2.0 },     /* float above full scale */
        };
        for (int k = 0; k < 4; k++) {
            write_sine(cases[k].path, 20000, cases[k].ch, cases[k].bits, cases[k].fmt, cases[k].amp);
            double peak = file_peak(cases[k].path, cases[k].fmt, cases[k].bits);
            double full = cases[k].fmt == 3 ? 1.0 : 1.0 - 1.0 / (1 << (cases[k].bits - 1));
            double exact = 200 * log10(full / peak);
            inst = load(cases[k].path);
            char g[32];
            get(inst, "normalize_gain", g, sizeof g);
            int got = atoi(g);
            CHECK(got <= exact + 1e-6 && got > exact - 1, "%s: normalize_gain %s, exact %.2f (rounded down)", cases[k].path, g, exact);
            api->destroy_instance(inst);
        }
        FILE *nf = fopen("build/nneg.wav", "wb");          /* -32768 is full scale */
        fwrite("RIFF", 1, 4, nf); wr32(nf, 36 + 4); fwrite("WAVE", 1, 4, nf);
        fwrite("fmt ", 1, 4, nf); wr32(nf, 16); wr16(nf, 1); wr16(nf, 1);
        wr32(nf, 44100); wr32(nf, 88200); wr16(nf, 2); wr16(nf, 16);
        fwrite("data", 1, 4, nf); wr32(nf, 4); wr16(nf, -32768); wr16(nf, 100);
        fclose(nf);
        inst = load("build/nneg.wav");
        char g[32];
        get(inst, "normalize_gain", g, sizeof g);
        CHECK(strcmp(g, "-1") == 0, "-32768 peak: normalize_gain %s (just under 0 dB)", g);
        api->destroy_instance(inst);
        write_sine("build/nsilent.wav", 1000, 1, 16, 1, 0.0);
        inst = load("build/nsilent.wav");
        get(inst, "normalize_gain", g, sizeof g);
        CHECK(strcmp(g, "silent") == 0, "silent file: normalize_gain %s", g);
        api->destroy_instance(inst);
    }

    /* ---- Slice export applies the gain ---- */
    {
        mkdir("build/gexp", 0755);
        struct { const char *src; int ch, bits, fmt; } cases[] = {
            { "build/n24.wav", 2, 24, 1 },
            { "build/nf32.wav", 2, 32, 3 },
        };
        for (int k = 0; k < 2; k++) {
            int bits = cases[k].bits, fmt = cases[k].fmt;
            inst = load(cases[k].src);
            remove("build/gexp/g 01.wav");
            param(inst, "gain_db10", "130");                /* +13 dB: 0.25 -> 1.12, clips in PCM */
            char st[64];
            get(inst, "export_result", st, sizeof st);
            param(inst, "export_slices", "build/gexp/g");
            for (int t = 0; t < 400; t++) {
                get(inst, "export_result", st, sizeof st);
                if (strcmp(st, "1 1 1") == 0) break;
                usleep(5000);
            }
            CHECK(strcmp(st, "1 1 1") == 0, "%s: gained export done: %s", cases[k].src, st);
            long sl = 0, dl = 0;
            uint8_t *sb = read_file(cases[k].src, &sl), *db = read_file("build/gexp/g 01.wav", &dl);
            CHECK(sb && db && sl == dl && memcmp(sb + 8, db + 8, 36) == 0, "%s: same format and length", cases[k].src);
            if (sb && db && sl == dl) {
                double g = pow(10, 0.65), worst = 0, lsb = fmt == 3 ? 1e-6 : 1.0 / (1 << (bits - 1));
                int clipped = 0;
                for (long i = 44; i + bits / 8 <= sl; i += bits / 8) {
                    double want = read_native(sb + i, fmt, bits) * g, got = read_native(db + i, fmt, bits);
                    if (fmt == 1 && fabs(want) >= 1.0 - lsb) { clipped++; continue; }
                    double e = fabs(got - want);
                    if (e > worst) worst = e;
                }
                CHECK(worst <= lsb, "%s: slice samples scaled by +13 dB (worst %g)", cases[k].src, worst);
                if (fmt == 1) CHECK(clipped > 0, "%s: 0.25 x 4.47 clips in PCM (%d clipped)", cases[k].src, clipped);
            }
            free(sb); free(db);
            param(inst, "gain_db10", "-700");
            remove("build/gexp/s 01.wav");
            param(inst, "export_slices", "build/gexp/s");
            for (int t = 0; t < 400; t++) {
                get(inst, "export_result", st, sizeof st);
                if (strcmp(st, "2 2 1") == 0) break;
                usleep(5000);
            }
            db = read_file("build/gexp/s 01.wav", &dl);
            double low = 0;
            for (long i = 44; db && i + bits / 8 <= dl; i += bits / 8) low = fmax(low, fabs(read_native(db + i, fmt, bits)));
            double lsb = fmt == 3 ? 1e-9 : 1.0 / (1 << (bits - 1));
            CHECK(db && dl == sl && fabs(low - 0.25 * pow(10, -3.5)) <= lsb, "%s: -70 dB export peaks at %g", cases[k].src, low);
            free(db);
            api->destroy_instance(inst);
        }
    }

    /* ---- Channels: rewrite as 1 channel (mean, left or right) in place ---- */
    {
        struct { const char *path; int bits, fmt; } fmts[] = {
            { "build/c16.wav", 16, 1 }, { "build/c24.wav", 24, 1 }, { "build/cf32.wav", 32, 3 },
        };
        const char *modes[] = { "mono", "left", "right" };
        for (int k = 0; k < 3; k++) {
            for (int m = 0; m < 3; m++) {
                const char *path = fmts[k].path;
                int bits = fmts[k].bits, fmt = fmts[k].fmt, bps = bits / 8;
                write_sine(path, 20000, 2, bits, fmt, 0.5);  /* L = sin(x), R = sin(x + 1) */
                chmod(path, 0640);
                long ol = 0;
                uint8_t *ob = read_file(path, &ol);
                inst = load(path);
                note(inst, 68); render(inst, 40); note(inst, 69);     /* chop: 2 slices */
                char before[128];
                snprintf(before, sizeof before, "%s", slices(inst));
                int depth = field(inst, F_UNDO_DEPTH);
                note(inst, 68); render(inst, 2);                      /* playing through the swap */
                int status = convert(inst, modes[m]);
                CHECK(status == CONV_OK, "%s %s: converted (status %d)", path, modes[m], status);
                long nl = 0;
                uint8_t *nb = read_file(path, &nl);
                CHECK(nb && nl == 44 + 20000L * bps, "%s %s: 1-channel size %ld", path, modes[m], nl);
                if (ob && nb && nl == 44 + 20000L * bps) {
                    CHECK(rd_u16(nb + 22) == 1 && rd_u16(nb + 32) == bps && rd_u32(nb + 28) == 44100u * (uint32_t)bps &&
                          rd_u32(nb + 40) == 20000u * (uint32_t)bps && rd_u32(nb + 4) == (uint32_t)(nl - 8),
                          "%s %s: header says 1 channel", path, modes[m]);
                    CHECK(rd_u16(nb + 20) == fmt && rd_u16(nb + 34) == bits && rd_u32(nb + 24) == 44100, "%s %s: format kept", path, modes[m]);
                    double worst = 0, lsb = fmt == 3 ? 1e-6 : 1.0 / (1 << (bits - 1));
                    for (long i = 0; i < 20000; i++) {
                        double l = read_native(ob + 44 + i * 2 * bps, fmt, bits);
                        double r = read_native(ob + 44 + i * 2 * bps + bps, fmt, bits);
                        double want = m == 0 ? (l + r) / 2 : m == 1 ? l : r;
                        double e = fabs(read_native(nb + 44 + i * bps, fmt, bits) - want);
                        if (e > worst) worst = e;
                    }
                    CHECK(worst <= lsb, "%s %s: samples are the %s (worst error %g)", path, modes[m], modes[m], worst);
                }
                free(ob); free(nb);
                struct stat st;
                CHECK(stat(path, &st) == 0 && (st.st_mode & 0777) == 0640, "%s %s: permissions kept", path, modes[m]);
                char tmp[600], ch[16];
                snprintf(tmp, sizeof tmp, "%s.convert-tmp", path);
                CHECK(!exists(tmp), "%s %s: no temp file left", path, modes[m]);
                CHECK(strcmp(before, slices(inst)) == 0, "%s %s: slices kept (%s -> %s)", path, modes[m], before, slices(inst));
                CHECK(field(inst, F_UNDO_DEPTH) == depth, "%s %s: undo history kept", path, modes[m]);
                CHECK(field(inst, F_PLAYING) == 0, "%s %s: the voice keeps playing", path, modes[m]);
                get(inst, "channels", ch, sizeof ch);
                CHECK(strcmp(ch, "1") == 0, "%s %s: now 1 channel (%s)", path, modes[m], ch);
                if (k == 0) {
                    /* Both outputs now play the one channel */
                    until_silent(inst);
                    note(inst, 68);
                    api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
                    double x = 20 * 0.05, l = 0.5 * sin(x), r = 0.5 * sin(x + 1);
                    int16_t want = (int16_t)lrint(32768 * (m == 0 ? (l + r) / 2 : m == 1 ? l : r));
                    CHECK(out[40] == out[41] && abs(out[40] - want) <= 1, "%s: playback is the %s on both sides (%d %d, want %d)", path, modes[m], out[40], out[41], want);
                }
                /* Already 1 channel: nothing written */
                struct stat st2;
                stat(path, &st);
                CHECK(convert(inst, "left") == CONV_ALREADY_MONO, "%s %s: then already mono", path, modes[m]);
                CHECK(stat(path, &st2) == 0 && st2.st_ino == st.st_ino, "%s %s: mono file left alone", path, modes[m]);
                api->destroy_instance(inst);
            }
        }

        /* WAVE_FORMAT_EXTENSIBLE stereo: the copy says centre */
        FILE *ef = fopen("build/cext.wav", "wb");
        int frames = 1000, data = frames * 4;
        fwrite("RIFF", 1, 4, ef); wr32(ef, 4 + 8 + 40 + 8 + data); fwrite("WAVE", 1, 4, ef);
        fwrite("fmt ", 1, 4, ef); wr32(ef, 40); wr16(ef, 0xFFFE); wr16(ef, 2);
        wr32(ef, 44100); wr32(ef, 44100 * 4); wr16(ef, 4); wr16(ef, 16);
        wr16(ef, 22); wr16(ef, 16); wr32(ef, 0x3);                 /* cbSize, valid bits, FL|FR */
        wr16(ef, 1); wr16(ef, 0); wr32(ef, 0x00100000); wr32(ef, 0xAA000080); wr32(ef, 0x719B3800); /* PCM GUID */
        fwrite("data", 1, 4, ef); wr32(ef, data);
        for (int i = 0; i < frames; i++) { wr16(ef, 1000); wr16(ef, 3000); }
        fclose(ef);
        inst = load("build/cext.wav");
        CHECK(convert(inst, "mono") == CONV_OK, "extensible stereo converts");
        long el = 0;
        uint8_t *eb = read_file("build/cext.wav", &el);
        CHECK(eb && el == 12 + 8 + 40 + 8 + frames * 2 && rd_u16(eb + 20) == 0xFFFE && rd_u16(eb + 22) == 1 &&
              rd_u16(eb + 32) == 2 && rd_u32(eb + 40) == 0x4 && (int16_t)rd_u16(eb + 68) == 2000,
              "extensible: 1 channel, centre mask, mean sample (%ld bytes)", el);
        free(eb);
        api->destroy_instance(inst);

        /* A mono source is left alone */
        write_sine("build/cmono.wav", 1000, 1, 16, 1, 0.5);
        inst = load("build/cmono.wav");
        char ch[16];
        get(inst, "channels", ch, sizeof ch);
        CHECK(strcmp(ch, "1") == 0, "mono file reports 1 channel (%s)", ch);
        CHECK(convert(inst, "mono") == CONV_ALREADY_MONO, "mono source: already mono");
        api->destroy_instance(inst);

        /* Can't write next to it: the original is left as it was */
        if (geteuid() != 0) {
            mkdir("build/cro", 0755);
            write_sine("build/cro/q.wav", 2000, 2, 16, 1, 0.5);
            inst = load("build/cro/q.wav");
            chmod("build/cro", 0555);
            CHECK(convert(inst, "left") == CONV_FAILED, "unwritable folder fails");
            long ql = 0;
            free(read_file("build/cro/q.wav", &ql));
            CHECK(ql == 44 + 2000 * 4, "failed convert leaves the stereo original (%ld bytes)", ql);
            get(inst, "channels", ch, sizeof ch);
            CHECK(strcmp(ch, "2") == 0, "failed convert keeps playing stereo");
            chmod("build/cro", 0755);
            api->destroy_instance(inst);
        }

        /* No "loading" while the converted copy waits to be swapped in */
        {
            write_sine("build/cst.wav", 4000, 2, 16, 1, 0.5);
            inst = load("build/cst.wav");
            note(inst, 68); render(inst, 20); note(inst, 69);
            param(inst, "convert_channels", "mono");
            live_chopper_t *lc = inst;
            for (int t = 0; t < 400 && !atomic_load(&lc->incoming); t++) usleep(5000);
            char st[64];
            get(inst, "status", st, sizeof st);
            CHECK(atomic_load(&lc->incoming) && strncmp(st, "ready", 5) == 0, "status while the copy waits: %s", st);
            render(inst, 1);
            get(inst, "status", st, sizeof st);
            CHECK(strncmp(st, "ready", 5) == 0, "status after the swap: %s", st);
            api->destroy_instance(inst);
        }

        /* A conversion of a file that was replaced meanwhile is dropped */
        {
            write_sine("build/csa.wav", 2000, 2, 16, 1, 0.5);
            write_sine("build/csb.wav", 2000, 2, 16, 1, 0.3);
            inst = load("build/csa.wav");
            live_chopper_t *lc = inst;
            param(inst, "file_path", "build/csb.wav");
            for (int t = 0; t < 400 && !atomic_load(&lc->incoming); t++) usleep(5000);
            param(inst, "convert_channels", "mono");      /* still of A: B isn't taken yet */
            for (int t = 0; t < 400 && atomic_load(&lc->conv_done_seq) != 1; t++) { render(inst, 1); usleep(5000); }
            render(inst, 4);
            char ch[16], st[64];
            get(inst, "channels", ch, sizeof ch);
            get(inst, "status", st, sizeof st);
            CHECK(lc->current && strcmp(lc->current->path, "build/csb.wav") == 0 && strcmp(ch, "2") == 0 &&
                  strncmp(st, "ready 2000", 10) == 0,
                  "stale conversion dropped: playing %s, %s channels, %s", lc->current ? lc->current->path : "-", ch, st);
            long al = 0;
            uint8_t *ab = read_file("build/csa.wav", &al);
            CHECK(ab && al == 44 + 2000 * 2 && rd_u16(ab + 22) == 1, "stale conversion still rewrote A (%ld bytes)", al);
            free(ab);
            api->destroy_instance(inst);
        }

        /* The converted file won't load: the original and the audio stay */
        {
            write_sine("build/clf.wav", 2000, 2, 16, 1, 0.5);
            long ol = 0, nl = 0;
            uint8_t *ob = read_file("build/clf.wav", &ol);
            inst = load("build/clf.wav");
            test_fail_convert_load = 1;
            CHECK(convert(inst, "mono") == CONV_FAILED, "load failure reports failed");
            test_fail_convert_load = 0;
            uint8_t *nb = read_file("build/clf.wav", &nl);
            CHECK(ob && nb && nl == ol && memcmp(ob, nb, (size_t)ol) == 0, "load failure leaves the original");
            CHECK(!exists("build/clf.wav.convert-tmp"), "load failure leaves no temp file");
            char ch[16];
            get(inst, "channels", ch, sizeof ch);
            CHECK(strcmp(ch, "2") == 0, "load failure keeps playing stereo (%s)", ch);
            free(ob); free(nb);
            api->destroy_instance(inst);
        }

        /* Data chunk longer than the file: converts the frames that are there */
        {
            write_sine("build/ctr.wav", 3000, 2, 16, 1, 0.5);
            FILE *tf = fopen("build/ctr.wav", "r+b");
            fseek(tf, 4, SEEK_SET); wr32(tf, 36 + 3000 * 4 + 4000);
            fseek(tf, 40, SEEK_SET); wr32(tf, 3000 * 4 + 4000);
            fclose(tf);
            inst = load("build/ctr.wav");
            note(inst, 68); render(inst, 20); note(inst, 69);
            char before[128];
            snprintf(before, sizeof before, "%s", slices(inst));
            CHECK(convert(inst, "left") == CONV_OK, "truncated file converts");
            long tl = 0;
            uint8_t *tb = read_file("build/ctr.wav", &tl);
            CHECK(tb && tl == 44 + 3000 * 2 && rd_u32(tb + 40) == 3000 * 2 && rd_u32(tb + 4) == (uint32_t)(tl - 8),
                  "truncated: 3000 frames written, header fixed (%ld bytes)", tl);
            CHECK(strcmp(before, slices(inst)) == 0, "truncated: slices kept (%s -> %s)", before, slices(inst));
            free(tb);
            api->destroy_instance(inst);
        }

        /* Other chunks are kept, per-channel ones dropped */
        {
            int frames = 500;
            FILE *cf = fopen("build/cchunks.wav", "wb");
            fwrite("RIFF", 1, 4, cf); wr32(cf, 4 + 24 + 16 + 32 + 8 + frames * 4 + 36); fwrite("WAVE", 1, 4, cf);
            fwrite("fmt ", 1, 4, cf); wr32(cf, 16); wr16(cf, 1); wr16(cf, 2);
            wr32(cf, 44100); wr32(cf, 44100 * 4); wr16(cf, 4); wr16(cf, 16);
            fwrite("LIST", 1, 4, cf); wr32(cf, 7); fwrite("INFOabc", 1, 7, cf); fputc(0, cf);  /* odd: padded */
            fwrite("PEAK", 1, 4, cf); wr32(cf, 24); for (int i = 0; i < 24; i++) fputc(i, cf);
            fwrite("data", 1, 4, cf); wr32(cf, frames * 4);
            for (int i = 0; i < frames; i++) { wr16(cf, 1000); wr16(cf, 3000); }
            fwrite("cue ", 1, 4, cf); wr32(cf, 28); for (int i = 0; i < 28; i++) fputc(100 + i, cf);
            fclose(cf);
            inst = load("build/cchunks.wav");
            CHECK(convert(inst, "mono") == CONV_OK, "file with extra chunks converts");
            long cl = 0;
            uint8_t *cb = read_file("build/cchunks.wav", &cl);
            long want = 12 + 24 + 16 + 8 + frames * 2 + 36;
            int ok = cb && cl == want && rd_u32(cb + 4) == (uint32_t)(cl - 8) &&
                     memcmp(cb + 36, "LIST", 4) == 0 && rd_u32(cb + 40) == 7 && memcmp(cb + 44, "INFOabc", 7) == 0 &&
                     memcmp(cb + 52, "data", 4) == 0 && rd_u32(cb + 56) == (uint32_t)frames * 2 &&
                     (int16_t)rd_u16(cb + 60) == 2000 && memcmp(cb + 60 + frames * 2, "cue ", 4) == 0 &&
                     rd_u32(cb + 64 + frames * 2) == 28 && cb[68 + frames * 2] == 100 && cb[cl - 1] == 127;
            CHECK(ok, "chunks: LIST and cue kept, PEAK dropped (%ld bytes, want %ld)", cl, want);
            free(cb);
            char ch[16];
            get(inst, "channels", ch, sizeof ch);
            CHECK(strcmp(ch, "1") == 0, "chunks: playing the 1-channel copy (%s)", ch);
            api->destroy_instance(inst);
        }

        /* A symlink stays a link; its target is converted */
        {
            write_sine("build/ctarget.wav", 1000, 2, 16, 1, 0.5);
            remove("build/clink.wav");
            CHECK(symlink("ctarget.wav", "build/clink.wav") == 0, "make symlink");
            inst = load("build/clink.wav");
            CHECK(convert(inst, "right") == CONV_OK, "symlinked sample converts");
            struct stat lst;
            CHECK(lstat("build/clink.wav", &lst) == 0 && S_ISLNK(lst.st_mode), "symlink still a link");
            long sl = 0;
            uint8_t *sb = read_file("build/ctarget.wav", &sl);
            CHECK(sb && sl == 44 + 1000 * 2 && rd_u16(sb + 22) == 1, "symlink target converted (%ld bytes)", sl);
            CHECK(!exists("build/ctarget.wav.convert-tmp") && !exists("build/clink.wav.convert-tmp"), "symlink: no temp file left");
            char fp[600];
            get(inst, "file_path", fp, sizeof fp);
            CHECK(strcmp(fp, "build/clink.wav") == 0 && strcmp(((live_chopper_t *)inst)->current->path, "build/clink.wav") == 0,
                  "symlink: still playing the link's path (%s)", fp);
            free(sb);
            api->destroy_instance(inst);
        }

        /* Hard links: refused, nothing written */
        {
            write_sine("build/chard.wav", 1000, 2, 16, 1, 0.5);
            remove("build/chard2.wav");
            CHECK(link("build/chard.wav", "build/chard2.wav") == 0, "make hard link");
            struct stat h1, h2;
            stat("build/chard.wav", &h1);
            inst = load("build/chard.wav");
            CHECK(convert(inst, "mono") == CONV_LINKED, "hard-linked sample refused");
            long hl = 0;
            free(read_file("build/chard2.wav", &hl));
            CHECK(stat("build/chard.wav", &h2) == 0 && h2.st_ino == h1.st_ino && h2.st_nlink == 2 && hl == 44 + 1000 * 4,
                  "hard links left alone (%ld bytes)", hl);
            CHECK(!exists("build/chard.wav.convert-tmp"), "hard link: no temp file left");
            char ch[16];
            get(inst, "channels", ch, sizeof ch);
            CHECK(strcmp(ch, "2") == 0, "hard link: still stereo (%s)", ch);
            api->destroy_instance(inst);
        }
    }

    /* ---- Bad file ---- */
    FILE *f = fopen("build/bad.wav", "wb"); fputs("not a wav", f); fclose(f);
    inst = load("build/bad.wav");
    get(inst, "status", st, sizeof st);
    char err[64];
    get(inst, "error", err, sizeof err);
    CHECK(strncmp(st, "error", 5) == 0 && strcmp(err, "Not a WAV file") == 0, "bad file: %s / %s", st, err);
    api->destroy_instance(inst);

    printf(failures ? "%d FAILED\n" : "all checks passed\n", failures);
    return failures ? 1 : 0;
}
