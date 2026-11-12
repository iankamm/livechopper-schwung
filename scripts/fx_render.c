/*
 * Render one pad of plugin.c on the host, for comparing against Move
 * (docs/PLAN.md, step 4; driven by scripts/fxlab.py):
 *
 *   fx_render <in.wav> <out.wav> <seconds> [key=value ...]
 *
 * Loads in.wav through the real worker thread, applies each key=value with
 * set_param in order, plays Pad 1 and writes <seconds> of stereo 16-bit
 * 44.1 kHz output. Two keys are the driver's own: release=<s> sends the
 * note-off at that time (for gate=1). Build:
 *
 *   gcc -std=c11 -O2 -Isrc/dsp scripts/fx_render.c -o build/fx_render -lm -lpthread
 */
#define LIVE_CHOPPER_TEST
#include "../src/dsp/plugin.c"

#include <unistd.h>

static void wr16(FILE *f, int v) { fputc(v & 255, f); fputc((v >> 8) & 255, f); }
static void wr32(FILE *f, int v) { wr16(f, v & 0xFFFF); wr16(f, (v >> 16) & 0xFFFF); }

static void midi(plugin_api_v2_t *api, void *inst, uint8_t status, uint8_t note, uint8_t vel) {
    uint8_t m[3] = { status, note, vel };
    api->on_midi(inst, m, 3, MOVE_MIDI_SOURCE_INTERNAL);
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: fx_render <in.wav> <out.wav> <seconds> [key=value ...]\n");
        return 2;
    }
    plugin_api_v2_t *api = move_plugin_init_v2(NULL);
    void *inst = api->create_instance(".", NULL);
    api->set_param(inst, "file_path", argv[1]);
    int16_t out[MOVE_FRAMES_PER_BLOCK * 2];
    char st[256] = "";
    for (int t = 0; t < 2000; t++) {
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        if (api->get_param(inst, "status", st, sizeof st) < 0) st[0] = 0;
        if (strncmp(st, "ready", 5) == 0 || strncmp(st, "error", 5) == 0) break;
        usleep(2000);
    }
    if (strncmp(st, "ready", 5) != 0) {
        fprintf(stderr, "fx_render: %s did not load (%s)\n", argv[1], st);
        return 1;
    }

    double release_s = -1;
    for (int i = 4; i < argc; i++) {
        char key[64];
        const char *eq = strchr(argv[i], '=');
        if (!eq || eq - argv[i] >= (int)sizeof key) {
            fprintf(stderr, "fx_render: bad setting %s\n", argv[i]);
            return 2;
        }
        memcpy(key, argv[i], (size_t)(eq - argv[i]));
        key[eq - argv[i]] = 0;
        if (strcmp(key, "release") == 0) release_s = atof(eq + 1);
        else api->set_param(inst, key, eq + 1);
    }

    int frames = (int)(atof(argv[3]) * MOVE_SAMPLE_RATE);
    int blocks = (frames + MOVE_FRAMES_PER_BLOCK - 1) / MOVE_FRAMES_PER_BLOCK;
    int release_block = release_s >= 0 ? (int)(release_s * MOVE_SAMPLE_RATE) / MOVE_FRAMES_PER_BLOCK : -1;
    FILE *f = fopen(argv[2], "wb");
    if (!f) {
        fprintf(stderr, "fx_render: can't write %s\n", argv[2]);
        return 1;
    }
    int data = frames * 4;
    fwrite("RIFF", 1, 4, f); wr32(f, 36 + data); fwrite("WAVE", 1, 4, f);
    fwrite("fmt ", 1, 4, f); wr32(f, 16); wr16(f, 1); wr16(f, 2);
    wr32(f, MOVE_SAMPLE_RATE); wr32(f, MOVE_SAMPLE_RATE * 4); wr16(f, 4); wr16(f, 16);
    fwrite("data", 1, 4, f); wr32(f, data);

    midi(api, inst, 0x90, 68, 127);
    int written = 0;
    for (int b = 0; b < blocks; b++) {
        if (b == release_block) midi(api, inst, 0x80, 68, 0);
        api->render_block(inst, out, MOVE_FRAMES_PER_BLOCK);
        int n = frames - written < MOVE_FRAMES_PER_BLOCK ? frames - written : MOVE_FRAMES_PER_BLOCK;
        for (int i = 0; i < n * 2; i++) wr16(f, out[i]);
        written += n;
    }
    fclose(f);
    api->destroy_instance(inst);
    return 0;
}
