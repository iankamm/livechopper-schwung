/*
 * Chopper DSP Plugin
 *
 * Real-time sample chopping across pads. See SPEC.md.
 *
 * V2 API only. Every entry point below runs on the SPI audio callback
 * (see plugin_api_v1.h): no malloc/free, no file I/O, no logging, no locks,
 * no unbounded loops. create_instance/destroy_instance for an overtake tool
 * run on the shim worker, so allocation is allowed there and only there.
 *
 * Step 0: silence, plus a pad-note probe that confirms pad MIDI reaches
 * on_midi on the audio thread (the basis for sample-accurate chops).
 */

#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdint.h>

#include "plugin_api_v1.h"

#define PAD_NOTE_MIN 68
#define PAD_NOTE_MAX 99
#define PATH_MAX_LEN 512

typedef struct {
    char file_path[PATH_MAX_LEN];

    /* Pad probe: written on the audio thread, read via get_param. */
    uint32_t pad_on_count;
    int last_pad_note;
    uint64_t block_count;
    uint64_t last_pad_block;
} chopper_t;

static const host_api_v1_t *g_host = NULL;

static void *create_instance(const char *module_dir, const char *json_defaults) {
    (void)module_dir;
    (void)json_defaults;
    chopper_t *inst = (chopper_t *)calloc(1, sizeof(chopper_t));
    if (!inst) return NULL;
    inst->last_pad_note = -1;
    return inst;
}

static void destroy_instance(void *instance) {
    free(instance);
}

static void on_midi(void *instance, const uint8_t *msg, int len, int source) {
    chopper_t *inst = (chopper_t *)instance;
    (void)source;
    if (!inst || len < 3) return;

    uint8_t type = msg[0] & 0xF0;
    uint8_t note = msg[1];
    uint8_t vel = msg[2];

    if (type == 0x90 && vel > 0 && note >= PAD_NOTE_MIN && note <= PAD_NOTE_MAX) {
        inst->pad_on_count++;
        inst->last_pad_note = note;
        inst->last_pad_block = inst->block_count;
    }
}

static void set_param(void *instance, const char *key, const char *val) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst || !key || !val) return;

    if (strcmp(key, "file_path") == 0) {
        /* Bounded copy only. Loading happens on a worker thread (step 1). */
        strncpy(inst->file_path, val, PATH_MAX_LEN - 1);
        inst->file_path[PATH_MAX_LEN - 1] = '\0';
    }
}

static int get_param(void *instance, const char *key, char *buf, int buf_len) {
    chopper_t *inst = (chopper_t *)instance;
    if (!inst || !key || !buf || buf_len <= 0) return -1;

    if (strcmp(key, "file_path") == 0) {
        return snprintf(buf, (size_t)buf_len, "%s", inst->file_path);
    }
    if (strcmp(key, "pad_probe") == 0) {
        /* "<count> <last note> <block of last press>" */
        return snprintf(buf, (size_t)buf_len, "%u %d %llu",
                        inst->pad_on_count, inst->last_pad_note,
                        (unsigned long long)inst->last_pad_block);
    }
    return -1;
}

static int get_error(void *instance, char *buf, int buf_len) {
    (void)instance;
    (void)buf;
    (void)buf_len;
    return 0;
}

static void render_block(void *instance, int16_t *out_interleaved_lr, int frames) {
    chopper_t *inst = (chopper_t *)instance;
    memset(out_interleaved_lr, 0, (size_t)frames * 2 * sizeof(int16_t));
    if (inst) inst->block_count++;
}

static plugin_api_v2_t s_plugin_api = {
    .api_version = MOVE_PLUGIN_API_VERSION_2,
    .create_instance = create_instance,
    .destroy_instance = destroy_instance,
    .on_midi = on_midi,
    .set_param = set_param,
    .get_param = get_param,
    .get_error = get_error,
    .render_block = render_block,
};

plugin_api_v2_t *move_plugin_init_v2(const host_api_v1_t *host_api) {
    g_host = host_api;
    return &s_plugin_api;
}
