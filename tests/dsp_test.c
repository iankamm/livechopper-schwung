/*
 * Host-side test for src/dsp/plugin.c: compiles the plugin in, loads WAVs
 * through the real worker thread, and drives pads/params like the host.
 *
 *   gcc -std=c11 -g -fsanitize=address,undefined -Isrc/dsp \
 *       tests/dsp_test.c -o build/dsp_test -lm -lpthread && build/dsp_test
 */
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
    CHECK(strcmp(det + strlen(det) - 3, " 50") == 0, "detune clamped and reported: %s", det);
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
    CHECK(strcmp(set, "0 -1 10000 0 0 0") == 0, "one-shot by default: %s", set);
    note(inst, 68); render(inst, 2);
    note_off(inst, 68); render(inst, 20);
    CHECK(field(inst, F_PLAYING) == 0, "one-shot ignores the pad being let go");
    param(inst, "gate", "1");               /* pad already let go: release now */
    render(inst, 5);
    CHECK(field(inst, F_PLAYING) == -1, "switching to gated after letting go releases");
    get(inst, "settings", set, sizeof set);
    CHECK(strcmp(set, "0 -1 10000 0 1 0") == 0, "gated reported: %s", set);
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
