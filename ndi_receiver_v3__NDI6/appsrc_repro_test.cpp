// Minimal repro: mimics ndi_receiver_v4.cpp's exact appsrc push pattern
// (same pipeline string shape, same signal-based push-buffer from a detached
// thread, same buffer construction/unref pattern) but with synthetic UYVY
// data instead of real NDI frames. If this freezes after frame 1 too, the
// bug is in the push mechanism itself, independent of NDI.
//
// v2: now includes the SECOND (audio) appsrc branch in the same shared
// pipeline, interleaved from the SAME single thread — matching
// ndi_receiver_v4.cpp's real structure (video-only repro v1 worked fine;
// this tests whether the dual-appsrc-in-one-pipeline structure is the
// actual differentiator).
//
// Build:
//   g++ -o appsrc_repro_test appsrc_repro_test.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) -lX11 -std=c++11
// Run:
//   ./appsrc_repro_test

#include <iostream>
#include <thread>
#include <chrono>
#include <atomic>
#include <cstring>
#include <csignal>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <X11/Xlib.h>

static std::atomic<bool> g_running(true);
static GMainLoop *g_loop = nullptr;

void signalHandler(int)
{
    g_running = false;
    if (g_loop && g_main_loop_is_running(g_loop))
        g_main_loop_quit(g_loop);
}

int main()
{
    XInitThreads();
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    gst_init(nullptr, nullptr);

    const int width = 1920;
    const int height = 1080;
    const int framerate_n = 30, framerate_d = 1;
    const unsigned long frame_size = (unsigned long)width * height * 2; // UYVY
    const unsigned long video_max_bytes = frame_size * 4;

    const int sample_rate = 48000;
    const int channels = 2;
    const int samples_per_chunk = sample_rate / framerate_n; // ~1 chunk per video frame, like NDI
    const unsigned long audio_chunk_bytes = (unsigned long)samples_per_chunk * channels * sizeof(short);
    const unsigned long audio_max_bytes = 1 * 1024 * 1024;

    char pipeline_str[1536];
    snprintf(pipeline_str, sizeof(pipeline_str),
             "appsrc name=ndi_src format=time is-live=true block=false do-timestamp=true max-latency=0 "
             "max-bytes=%lu leaky-type=downstream "
             "caps=video/x-raw,format=UYVY,width=%d,height=%d,framerate=%d/%d ! "
             "queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream ! "
             "videoconvert ! "
             "videoscale method=bilinear add-borders=false ! "
             "video/x-raw,width=%d,height=%d ! "
             "ximagesink name=vsink sync=false "
             "appsrc name=audio_src format=time is-live=true block=false do-timestamp=true "
             "max-bytes=%lu leaky-type=downstream "
             "caps=audio/x-raw,format=S16LE,channels=%d,rate=%d,layout=interleaved ! "
             "queue ! audioconvert ! audioresample ! fakesink sync=false",
             video_max_bytes, width, height, framerate_n, framerate_d, width, height,
             audio_max_bytes, channels, sample_rate);

    GError *error = nullptr;
    GstElement *pipeline = gst_parse_launch(pipeline_str, &error);
    if (error)
    {
        std::cerr << "Pipeline error: " << error->message << std::endl;
        g_error_free(error);
        return 1;
    }

    GstElement *appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "ndi_src");
    GstElement *audio_appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "audio_src");
    gst_element_set_state(pipeline, GST_STATE_PLAYING);

    // Load a real captured NDI frame if ndi_receiver_v4.cpp dumped one, so we
    // can test whether genuine pixel content (not synthetic solid color)
    // triggers the freeze even through this known-good push harness.
    uint8_t *real_frame = nullptr;
    {
        FILE *f = fopen("/tmp/ndi_real_frame.raw", "rb");
        if (f)
        {
            real_frame = new uint8_t[frame_size];
            size_t got = fread(real_frame, 1, frame_size, f);
            fclose(f);
            if (got != frame_size)
            {
                std::cerr << "- Warning: dumped frame size (" << got << ") != expected (" << frame_size << ")" << std::endl;
                delete[] real_frame;
                real_frame = nullptr;
            }
            else
            {
                std::cout << "- Loaded real NDI frame from /tmp/ndi_real_frame.raw — looping REAL content." << std::endl;
            }
        }
        else
        {
            std::cout << "- No /tmp/ndi_real_frame.raw found — using synthetic solid color instead." << std::endl;
        }
    }

    std::thread feeder([&]() {
        uint8_t *pattern = new uint8_t[frame_size];
        short *audio_pattern = new short[samples_per_chunk * channels];
        uint64_t frame_count = 0;

        while (g_running)
        {
            if (real_frame)
            {
                // Loop the exact same real captured frame every time — content
                // is the variable under test here, not motion/animation.
                memcpy(pattern, real_frame, frame_size);
            }
            else
            {
                // Cycle a solid UYVY color so motion is visually obvious (varies luma byte).
                uint8_t luma = (uint8_t)(frame_count % 256);
                for (unsigned long i = 0; i < frame_size; i += 2)
                {
                    pattern[i] = 128;   // U/V
                    pattern[i + 1] = luma; // Y
                }
            }

            GstBuffer *buffer = gst_buffer_new_allocate(nullptr, frame_size, nullptr);
            GstMapInfo map;
            gst_buffer_map(buffer, &map, GST_MAP_WRITE);
            memcpy(map.data, pattern, frame_size);
            gst_buffer_unmap(buffer, &map);

            GstFlowReturn ret;
            g_signal_emit_by_name(appsrc, "push-buffer", buffer, &ret);
            if (ret != GST_FLOW_OK)
            {
                std::cerr << "push-buffer failed: " << gst_flow_get_name(ret) << std::endl;
            }
            gst_buffer_unref(buffer);

            // Interleave an audio chunk right after each video frame, same as
            // receiveLoop()'s single-threaded switch(frame_type) round-robin.
            memset(audio_pattern, 0, samples_per_chunk * channels * sizeof(short));
            GstBuffer *audio_buffer = gst_buffer_new_allocate(nullptr, audio_chunk_bytes, nullptr);
            GstMapInfo amap;
            gst_buffer_map(audio_buffer, &amap, GST_MAP_WRITE);
            memcpy(amap.data, audio_pattern, audio_chunk_bytes);
            gst_buffer_unmap(audio_buffer, &amap);

            GstFlowReturn aret;
            g_signal_emit_by_name(audio_appsrc, "push-buffer", audio_buffer, &aret);
            if (aret != GST_FLOW_OK)
            {
                std::cerr << "audio push-buffer failed: " << gst_flow_get_name(aret) << std::endl;
            }
            gst_buffer_unref(audio_buffer);

            frame_count++;
            if (frame_count <= 5 || frame_count % 30 == 0)
            {
                std::cout << "- Pushed synthetic frame: " << frame_count << std::endl;
            }

            // Bursty pacing instead of a smooth fixed interval: push 5 frames
            // back-to-back with no delay, then sleep ~5 frames' worth at once.
            // Real NDI network delivery is never perfectly metronomic like our
            // original sleep_for(33ms)-every-frame pacing was — this tests
            // whether rapid back-to-back pushes (vs. smooth pacing) is what
            // actually differs from the real, freezing NDI-driven case.
            if (frame_count % 5 != 0)
            {
                // no sleep — fire the next push immediately
            }
            else
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(5 * (1000 / framerate_n)));
            }
        }
        delete[] pattern;
        delete[] audio_pattern;
    });

    GstElement *vsink = gst_bin_get_by_name(GST_BIN(pipeline), "vsink");
    GstPad *sinkpad = gst_element_get_static_pad(vsink, "sink");
    static uint64_t sink_count = 0;
    gst_pad_add_probe(sinkpad, GST_PAD_PROBE_TYPE_BUFFER,
                       [](GstPad *, GstPadProbeInfo *, gpointer) -> GstPadProbeReturn {
                           sink_count++;
                           if (sink_count <= 5 || sink_count % 30 == 0)
                           {
                               std::cout << "- Buffer reached video sink pad: " << sink_count << std::endl;
                           }
                           return GST_PAD_PROBE_OK;
                       },
                       nullptr, nullptr);
    gst_object_unref(sinkpad);
    gst_object_unref(vsink);

    g_loop = g_main_loop_new(nullptr, FALSE);
    GstBus *bus = gst_pipeline_get_bus(GST_PIPELINE(pipeline));
    gst_bus_add_watch(bus, [](GstBus *, GstMessage *msg, gpointer) -> gboolean {
        if (GST_MESSAGE_TYPE(msg) == GST_MESSAGE_ERROR)
        {
            GError *err = nullptr;
            gchar *debug = nullptr;
            gst_message_parse_error(msg, &err, &debug);
            std::cerr << "GStreamer ERROR: " << err->message << std::endl;
            g_error_free(err);
            g_free(debug);
        }
        return TRUE;
    }, nullptr);
    gst_object_unref(bus);

    std::cout << "- Running. Press Ctrl+C to stop." << std::endl;
    g_main_loop_run(g_loop);

    std::cout << "- Shutting down..." << std::endl;
    // g_running is already false by the time g_main_loop_quit() is reachable
    // (signalHandler sets it first), so the feeder thread's loop condition
    // will see it and exit; join it before tearing down the pipeline so it
    // can't push into an element that's mid-teardown/destroyed.
    if (feeder.joinable())
        feeder.join();

    gst_element_set_state(pipeline, GST_STATE_NULL);
    gst_element_get_state(pipeline, nullptr, nullptr, GST_CLOCK_TIME_NONE);

    gst_object_unref(appsrc);
    gst_object_unref(audio_appsrc);
    gst_object_unref(pipeline);
    g_main_loop_unref(g_loop);
    delete[] real_frame;

    std::cout << "- Clean shutdown complete." << std::endl;
    return 0;
}
