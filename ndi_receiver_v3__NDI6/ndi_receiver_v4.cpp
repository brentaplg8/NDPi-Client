/**
 * NDI Receiver v3 - NDI SDK v5 with Dynamic Library Loading
 *
 * Features:
 * - NDI SDK v5 support (recv_capture_v2, audio_frame_v2_t)
 * - Dynamic library loading - no compile-time linking required
 * - Automatic display resolution detection (wlr-randr, fbset, drm, env)
 * - GStreamer pipeline with low-latency optimizations
 * - Audio conversion from NDI float to 16-bit PCM
 *
 * Compilation:
 *    g++ -o ndi_receiver_v4 ndi_receiver_v4.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) -I"/opt/NDI SDK for Linux/include" -ldl -std=c++11
 *    g++ -o ndi_receiver_v4 ndi_receiver_v4.cpp $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-app-1.0) -I"include" -ldl -std=c++11
 *
 * Usage:
 *    ./ndi_receiver_v# "NDI Source Name"
 *
 * Requirements:
 * - NDI SDK installed (library will be dynamically loaded)
 * - GStreamer 1.0 with gst-plugins-base, gst-plugins-good
 */

#include <iostream>
#include <string>
#include <cstring>
#include <thread>
#include <chrono>
#include <signal.h>
#include <cstdlib>
#include <dlfcn.h>
#include <gst/gst.h>
#include <gst/app/gstappsrc.h>
#include <Processing.NDI.Lib.h>

// NDIlib_frame_type_compressed_video is not part of the public NDI SDK v6 enum.
// NDI HX sources deliver compressed frames with a compressed FourCC via the
// regular NDIlib_frame_type_video path. We keep this value for forward-compat.
// #ifndef NDIlib_frame_type_compressed_video
// #  define NDIlib_frame_type_compressed_video ((NDIlib_frame_type_e)5)
// #endif

// NDI SDK v6 Dynamic Loading
struct NDILib
{
    void *handle = nullptr;

    // Function pointers for NDI SDK v6
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char *(*version)(void) = nullptr;

    // Receiver functions (v6 uses v3 create, v3 capture, v3 audio frame)
    NDIlib_recv_instance_t (*recv_create_v3)(const NDIlib_recv_create_v3_t *p_create_settings) = nullptr;
    void (*recv_destroy)(NDIlib_recv_instance_t p_instance) = nullptr;
    void (*recv_connect)(NDIlib_recv_instance_t p_instance, const NDIlib_source_t *p_src) = nullptr;
    NDIlib_frame_type_e (*recv_capture_v3)(NDIlib_recv_instance_t p_instance,
                                           NDIlib_video_frame_v2_t *p_video_data,
                                           NDIlib_audio_frame_v3_t *p_audio_data,
                                           NDIlib_metadata_frame_t *p_metadata,
                                           uint32_t timeout_in_ms) = nullptr;
    void (*recv_free_video_v2)(NDIlib_recv_instance_t p_instance, const NDIlib_video_frame_v2_t *p_video_data) = nullptr;
    void (*recv_free_audio_v3)(NDIlib_recv_instance_t p_instance, const NDIlib_audio_frame_v3_t *p_audio_data) = nullptr;

    // Finder functions
    NDIlib_find_instance_t (*find_create_v2)(const NDIlib_find_create_t *p_create_settings) = nullptr;
    void (*find_destroy)(NDIlib_find_instance_t p_instance) = nullptr;
    bool (*find_wait_for_sources)(NDIlib_find_instance_t p_instance, uint32_t timeout_in_ms) = nullptr;
    const NDIlib_source_t *(*find_get_current_sources)(NDIlib_find_instance_t p_instance, uint32_t *p_no_sources) = nullptr;

    // Utility functions
    bool (*util_audio_to_interleaved_16s_v3)(const NDIlib_audio_frame_v3_t *p_src,
                                             NDIlib_audio_frame_interleaved_16s_t *p_dst) = nullptr;

    // FrameSync functions
    NDIlib_framesync_instance_t (*framesync_create)(NDIlib_recv_instance_t p_receiver) = nullptr;
    void (*framesync_destroy)(NDIlib_framesync_instance_t p_instance) = nullptr;
    void (*framesync_capture_video)(NDIlib_framesync_instance_t p_instance,
                                    NDIlib_video_frame_v2_t *p_video_data,
                                    NDIlib_frame_format_type_e field_type) = nullptr;
    void (*framesync_free_video)(NDIlib_framesync_instance_t p_instance, NDIlib_video_frame_v2_t *p_video_data) = nullptr;
    void (*framesync_capture_audio_v2)(NDIlib_framesync_instance_t p_instance,
                                       NDIlib_audio_frame_v3_t *p_audio_data,
                                       int sample_rate, int no_channels, int no_samples) = nullptr;
    void (*framesync_free_audio_v2)(NDIlib_framesync_instance_t p_instance, NDIlib_audio_frame_v3_t *p_audio_data) = nullptr;

    bool loadLibrary()
    {
        // Try to load NDI library from common locations
        const char *lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6", // Local v6
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so",   // Local dir
            "/usr/local/lib/libndi.so.6",                 // Linux
            "/usr/local/lib/libndi.so",                   // Linux fallback
            "/usr/local/lib/libndi.dylib",                // macOS Homebrew
            "/opt/homebrew/lib/libndi.dylib",             // macOS M1/M2 Homebrew
            "/usr/lib/libndi.so.6",                       // Linux alt
            "/usr/lib/libndi.so",                         // Linux alt fallback
            "libndi.dylib",                               // macOS system
            "libndi.so.6",                                // Linux v6 system
            "libndi.so",                                  // Linux system fallback
            nullptr};

        for (int i = 0; lib_paths[i] != nullptr; i++)
        {
            handle = dlopen(lib_paths[i], RTLD_LAZY | RTLD_LOCAL);
            if (handle)
            {
                // std::cout << "- Loaded NDI library from: " << lib_paths[i] << std::endl;
                break;
            }
        }

        if (!handle)
        {
            std::cerr << "Failed to load NDI library: " << dlerror() << std::endl;
            return false;
        }

// Load function pointers
#define LOAD_FUNC(name)                                                                \
    name = reinterpret_cast<decltype(name)>(dlsym(handle, "NDIlib_" #name));           \
    if (!name)                                                                         \
    {                                                                                  \
        std::cerr << "Failed to load NDIlib_" #name << ": " << dlerror() << std::endl; \
        dlclose(handle);                                                               \
        handle = nullptr;                                                              \
        return false;                                                                  \
    }

        LOAD_FUNC(initialize);
        LOAD_FUNC(destroy);
        LOAD_FUNC(version);
        LOAD_FUNC(recv_create_v3);
        LOAD_FUNC(recv_destroy);
        LOAD_FUNC(recv_connect);
        LOAD_FUNC(recv_capture_v3);
        LOAD_FUNC(recv_free_video_v2);
        LOAD_FUNC(recv_free_audio_v3);
        LOAD_FUNC(find_create_v2);
        LOAD_FUNC(find_destroy);
        LOAD_FUNC(find_wait_for_sources);
        LOAD_FUNC(find_get_current_sources);
        LOAD_FUNC(util_audio_to_interleaved_16s_v3);
        LOAD_FUNC(framesync_create);
        LOAD_FUNC(framesync_destroy);
        LOAD_FUNC(framesync_capture_video);
        LOAD_FUNC(framesync_free_video);
        LOAD_FUNC(framesync_capture_audio_v2);
        LOAD_FUNC(framesync_free_audio_v2);

#undef LOAD_FUNC

        // std::cout << "- " << version() << std::endl;
        return true;
    }

    void unloadLibrary()
    {
        if (handle)
        {
            dlclose(handle);
            handle = nullptr;
        }
    }
};

// Global NDI library instance
NDILib g_ndi;

class NDIReceiver
{
private:
    NDIlib_recv_instance_t ndi_recv = nullptr;
    NDIlib_framesync_instance_t ndi_framesync = nullptr;
    bool use_framesync = false;

    GstElement *pipeline = nullptr;
    GstElement *appsrc = nullptr;
    GstElement *audio_appsrc = nullptr;
    GMainLoop *main_loop = nullptr;

    std::string current_source;

    NDIlib_recv_bandwidth_e bandwidth_setting = NDIlib_recv_bandwidth_highest;
    NDIlib_recv_color_format_e color_format_setting = NDIlib_recv_color_format_fastest;

    bool is_running = false;
    bool first_frame_logged = false;
    bool is_stalled = false;
    std::string scale_method = "bilinear";

    int source_width = 0;
    int source_height = 0;
    double frame_rate = 0.0;

    // Default to 4K
    int display_width = 3840;
    int display_height = 2160;

    std::string display_name = "Generic Display";
    bool pipeline_created = false;

    int actual_frame_width = 0;
    int actual_frame_height = 0;
    int actual_frame_rate_n = 0;
    int actual_frame_rate_d = 1;

    // Compressed (NDI HX) pipeline — H.264 / H.265
    GstElement *comp_pipeline = nullptr;
    bool comp_pipeline_created = false;
    int actual_comp_width = 0;
    int actual_comp_height = 0;
    int actual_comp_rate_n = 0;
    int actual_comp_rate_d = 1;
    bool actual_comp_is_hevc = false;

    // Multiple methods to detect display resolution
    void detectDisplayResolution()
    {

        /**
         * Method 1:
         *  xrandr
         */
        FILE *pipe = popen("xrandr | grep '*'", "r");
        if (pipe)
        {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe))
            {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100)
                {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    // std::cout << "Display_Resolution " << display_width << "x" << display_height << " (xrandr)" << std::endl;
                    return;
                }
            }
            pclose(pipe);
            pipe = nullptr; // Mark as closed
        }

        /**
         * Method 2:
         * use '/sys/class/drm' for HDMI
         */
        pipe = popen("cat /sys/class/drm/card*-HDMI-A-1/modes 2>/dev/null | head -1", "r");
        if (pipe)
        {
            char buffer[128];
            if (fgets(buffer, sizeof(buffer), pipe))
            {
                int w, h;
                if (sscanf(buffer, "%dx%d", &w, &h) == 2 && w > 100 && h > 100)
                {
                    display_width = w;
                    display_height = h;
                    pclose(pipe);
                    std::cout << "Display: " << display_width << "x" << display_height << " (drm)" << std::endl;
                    return;
                }
            }
            pclose(pipe);
            pipe = nullptr; // Mark as closed
        }

        /**
         * Fallback:
         */
        display_width = 1920;
        display_height = 1080;
        // std::cout << "Display_Resolution " << display_width << "x" << display_height << " (Fallback)" << std::endl;
    }

public:
    NDIReceiver(
        NDIlib_recv_bandwidth_e bandwidth = NDIlib_recv_bandwidth_max,
        NDIlib_recv_color_format_e color_format = NDIlib_recv_color_format_fastest,
        bool enable_framesync = false,
        const std::string &scale_method_arg = "bilinear") : bandwidth_setting(bandwidth), color_format_setting(color_format), use_framesync(enable_framesync), scale_method(scale_method_arg)
    {
        // NDIReceiver() {
        //  Initialize GStreamer
        gst_init(nullptr, nullptr);

        // Initialize member variables
        pipeline = nullptr;
        appsrc = nullptr;
        audio_appsrc = nullptr;
        main_loop = nullptr;
        ndi_recv = nullptr;

        // Detect display resolution
        detectDisplayResolution();

        // Initialize NDI using dynamically loaded library
        if (!g_ndi.initialize())
        {
            throw std::runtime_error("Failed to initialize NDI");
        }

        // Create NDI receiver with v3 struct - LOW LATENCY MODE (SDK v5)
        NDIlib_recv_create_v3_t recv_desc;
        recv_desc.source_to_connect_to.p_ndi_name = nullptr;
        recv_desc.source_to_connect_to.p_url_address = nullptr;

        /**
         *
         * NDIlib_recv_bandwidth_metadata_only  = -10,          // Receive metadata.
         * NDIlib_recv_bandwidth_audio_only     = 10,           // Receive metadata, audio.
         * NDIlib_recv_bandwidth_lowest         = 0,            // Receive metadata, audio, video at a lower bandwidth and resolution.
         * NDIlib_recv_bandwidth_highest        = 100,          // Receive metadata, audio, video at full resolution.
         * NDIlib_recv_bandwidth_max            = 0x7fffffff
         *
         */
        recv_desc.bandwidth = bandwidth_setting;
        std::cout << "- Bandwidth: " << bandwidth_setting << std::endl;
        // recv_desc.bandwidth = NDIlib_recv_bandwidth_max;

        /**
         *
         * NDIlib_recv_color_format_BGRX_BGRA   = 0
         * NDIlib_recv_color_format_UYVY_BGRA   = 1
         * NDIlib_recv_color_format_RGBX_RGBA   = 2
         * NDIlib_recv_color_format_UYVY_RGBA   = 3
         * NDIlib_recv_color_format_fastest     = 100
         * NDIlib_recv_color_format_best        = 101
         *
         */
        recv_desc.color_format = color_format_setting;
        std::cout << "- Color Format: " << color_format_setting << std::endl;
        // recv_desc.color_format = NDIlib_recv_color_format_UYVY_RGBA;

        recv_desc.allow_video_fields = false; // Disable interlaced - reduces latency
        recv_desc.p_ndi_recv_name = "NDPi-Monitor-Client";

        ndi_recv = g_ndi.recv_create_v3(&recv_desc);
        if (!ndi_recv)
        {
            throw std::runtime_error("Failed to create NDI receiver");
        }

        if (use_framesync)
        {
            // Wrap the receiver with a framesync instance
            ndi_framesync = g_ndi.framesync_create(ndi_recv);
            if (!ndi_framesync)
            {
                throw std::runtime_error("Failed to create NDI framesync instance");
            }
        }

        main_loop = g_main_loop_new(nullptr, FALSE);
    }

    ~NDIReceiver()
    {
        stop();
        if (ndi_recv)
            g_ndi.recv_destroy(ndi_recv);
        if (ndi_framesync)
            g_ndi.framesync_destroy(ndi_framesync);
        if (main_loop)
            g_main_loop_unref(main_loop);
        g_ndi.destroy();
    }

    bool connectToSource(const std::string &source_name)
    {
        if (source_name == "None" || source_name.empty())
        {
            stop();
            return true;
        }

        // Find the source using v2 struct
        NDIlib_find_create_t find_desc;
        find_desc.show_local_sources = true;
        find_desc.p_groups = nullptr;
        find_desc.p_extra_ips = nullptr;

        NDIlib_find_instance_t finder = g_ndi.find_create_v2(&find_desc);
        if (!finder)
        {
            std::cerr << "Failed to create NDI finder" << std::endl;
            return false;
        }

        uint32_t num_sources = 0;
        const NDIlib_source_t *sources = nullptr;

        std::cout << "- Searching NDI sources..." << std::endl;

        // Wait up to 15 seconds for sources
        auto start_time = std::chrono::high_resolution_clock::now();
        while ((std::chrono::high_resolution_clock::now() - start_time) < std::chrono::seconds(15))
        {
            g_ndi.find_wait_for_sources(finder, 1000);
            sources = g_ndi.find_get_current_sources(finder, &num_sources);

            if (num_sources > 0)
            {
                std::cout << "- Found " << num_sources << " NDI source(s):" << std::endl;
                for (uint32_t i = 0; i < num_sources; i++)
                {
                    std::cout << "-   " << i << " " << sources[i].p_ndi_name << " [" << sources[i].p_url_address << "]" << std::endl;
                }
                std::flush(std::cout);
            }

            // Check if we found our target
            for (uint32_t i = 0; i < num_sources; i++)
            {
                if (source_name == sources[i].p_ndi_name)
                {
                    std::cout << "- Target source found: " << source_name << std::endl;
                    // Connect to source (both standard and framesync use the same receiver)
                    g_ndi.recv_connect(ndi_recv, &sources[i]);
                    current_source = source_name;
                    g_ndi.find_destroy(finder);
                    return true;
                }
            }
        }

        std::cerr << "- Source not found. Available sources:" << std::endl;
        for (uint32_t i = 0; i < num_sources; i++)
        {
            std::cerr << "-   " << i << " " << sources[i].p_ndi_name << " [" << sources[i].p_url_address << "]" << std::endl;
        }

        g_ndi.find_destroy(finder);
        return false;
    }

    void createPipeline(int width, int height, int framerate_n, int framerate_d)
    {
        // Check if pipeline needs to be recreated (resolution or framerate changed)
        if (pipeline_created &&
            width == actual_frame_width &&
            height == actual_frame_height &&
            framerate_n == actual_frame_rate_n &&
            framerate_d == actual_frame_rate_d)
        {
            return; // Pipeline already matches
        }

        // Stop and destroy existing pipeline
        if (pipeline)
        {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            // Wait for state change to complete
            gst_element_get_state(pipeline, NULL, NULL, GST_CLOCK_TIME_NONE);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            pipeline_created = false;
        }
        // A source can switch from HX (compressed) to raw mid-stream. Tear down
        // the compressed pipeline too so it doesn't keep running (and leaking)
        // in the background — only one of {pipeline, comp_pipeline} should exist.
        if (comp_pipeline)
        {
            gst_element_set_state(comp_pipeline, GST_STATE_NULL);
            gst_element_get_state(comp_pipeline, NULL, NULL, GST_CLOCK_TIME_NONE);
            gst_object_unref(comp_pipeline);
            comp_pipeline = nullptr;
            comp_pipeline_created = false;
        }
        // Release audio_appsrc if it exists
        if (audio_appsrc)
        {
            gst_object_unref(audio_appsrc);
            audio_appsrc = nullptr;
        }

        actual_frame_width = width;
        actual_frame_height = height;
        actual_frame_rate_n = framerate_n;
        actual_frame_rate_d = framerate_d;

        double fps = (double)framerate_n / (double)framerate_d;

        // Log the format change
        std::cout << "Display_Resolution^" << display_width << "x" << display_height << std::endl;
        std::cout << "NDI_Source_Resolution^" << width << "x" << height << std::endl;
        std::cout << "NDI_Source_Framerate^" << fps << std::endl;
        std::flush(std::cout);

        // avdec_h265 -  libav HEVC (High Efficiency Video Coding) decoder
        // video/x-h265

        // "videoconvert ! "
        // "h265parse ! avdec_h265 ! videoconvert ! "
        // "h264parse ! avdec_h264 ! videoconvert ! "
        // const char* parse_elem = is_hevc ? "h265parse" : "h264parse";
        // const char* decode_elem = is_hevc ? "avdec_h265" : "avdec_h264";

        // "caps=video/x-raw,format=UYVY,width=%d,height=%d,framerate=%d/%d ! "
        // "caps=video/x-h265,stream-format=byte-stream,alignment=au ! "
        // "caps=video/x-h264,stream-format=byte-stream,alignment=au ! "
        // const char* video_caps  = is_hevc
        //     ? "video/x-h265,stream-format=byte-stream,alignment=au"
        //     : "video/x-h264,stream-format=byte-stream,alignment=au";

        // Create GStreamer pipeline with autovideosink - OPTIMIZED FOR LOW LATENCY
        // - queue max-size-buffers=1: minimal buffering
        // - leaky=downstream: drop frames if backed up rather than buffering
        // - sync=false: don't wait for clock sync
        //"caps=video/x-raw,format=UYVY,width=%d,height=%d,framerate=%d/%d ! "
        // With block=false, GstAppSrc ignores max-bytes for throttling (it only blocks
        // the pushing thread when block=true) — so if the pipeline (videoconvert/scale/
        // sink) can't keep up with the live NDI frame rate, appsrc's internal queue grows
        // without bound and shows up as a steady memory leak. leaky-type=downstream makes
        // appsrc drop its own oldest queued data instead of growing once max-bytes is hit.
        unsigned long video_max_bytes = (unsigned long)width * (unsigned long)height * 2 * 4; // ~4 raw UYVY frames
        const unsigned long audio_max_bytes = 1 * 1024 * 1024;                                // ~1MB of PCM audio

        char pipeline_str[1536];
        snprintf(pipeline_str, sizeof(pipeline_str),
                 "appsrc name=ndi_src format=time is-live=true block=false do-timestamp=true max-latency=0 "
                 "max-bytes=%lu leaky-type=downstream "
                 "caps=video/x-raw,format=UYVY,width=%d,height=%d,framerate=%d/%d ! "
                 "queue max-size-buffers=1 max-size-time=0 max-size-bytes=0 leaky=downstream ! "
                 "videoconvert ! "
                 "videoscale method=%s add-borders=false ! "
                 "video/x-raw,width=%d,height=%d ! "
                 "autovideosink sync=false "
                 "appsrc name=audio_src format=time is-live=true block=false do-timestamp=true "
                 "max-bytes=%lu leaky-type=downstream "
                 "caps=audio/x-raw,format=S16LE,channels=2,rate=48000,layout=interleaved ! "
                 "queue ! audioconvert ! audioresample ! autoaudiosink sync=false",
                 video_max_bytes,
                 width, height, framerate_n, framerate_d,
                 scale_method.c_str(),
                 display_width, display_height,
                 audio_max_bytes);

        GError *error = nullptr;
        pipeline = gst_parse_launch(pipeline_str, &error);

        if (error)
        {
            std::cerr << "Pipeline Error " << error->message << std::endl;
            g_error_free(error);
            return;
        }

        pipeline_created = true;

        audio_appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "audio_src");
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
        // block=false on both appsrcs means push-buffer never blocks regardless of pipeline state.
        // Let preroll complete naturally as the first frame flows through to autovideosink.
    }

    void createPipelineCompressed(int width, int height, int framerate_n, int framerate_d, bool is_hevc)
    {
        // Check if compressed pipeline already matches current parameters
        if (comp_pipeline_created &&
            width == actual_comp_width &&
            height == actual_comp_height &&
            framerate_n == actual_comp_rate_n &&
            framerate_d == actual_comp_rate_d &&
            is_hevc == actual_comp_is_hevc)
        {
            return;
        }

        // Stop and destroy existing compressed pipeline
        if (comp_pipeline)
        {
            gst_element_set_state(comp_pipeline, GST_STATE_NULL);
            gst_element_get_state(comp_pipeline, NULL, NULL, GST_CLOCK_TIME_NONE);
            gst_object_unref(comp_pipeline);
            comp_pipeline = nullptr;
            comp_pipeline_created = false;
        }

        // A source can switch from raw to HX (compressed) mid-stream. Tear down
        // the raw pipeline too so it doesn't keep running (and leaking) in the
        // background — only one of {pipeline, comp_pipeline} should exist.
        if (pipeline)
        {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_element_get_state(pipeline, NULL, NULL, GST_CLOCK_TIME_NONE);
            gst_object_unref(pipeline);
            pipeline = nullptr;
            pipeline_created = false;
        }

        // Release shared audio_appsrc previously held by this compressed pipeline
        if (audio_appsrc)
        {
            gst_object_unref(audio_appsrc);
            audio_appsrc = nullptr;
        }

        actual_comp_width = width;
        actual_comp_height = height;
        actual_comp_rate_n = framerate_n;
        actual_comp_rate_d = framerate_d;
        actual_comp_is_hevc = is_hevc;

        double fps = (double)framerate_n / (double)framerate_d;

        // Log the format change
        std::cout << "Display_Resolution^" << display_width << "x" << display_height << std::endl;
        std::cout << "NDI_Source_Resolution^" << width << "x" << height << std::endl;
        std::cout << "NDI_Source_Framerate^" << fps << std::endl;
        std::cout << "NDI_Source_Compression^" << (is_hevc ? "H.265/HEVC" : "H.264") << std::endl;
        std::flush(std::cout);

        // Select GStreamer parse + decode elements based on codec
        const char *parse_elem = is_hevc ? "h265parse" : "h264parse";
        const char *decode_elem = is_hevc ? "avdec_h265" : "avdec_h264";
        const char *video_caps = is_hevc
                                     ? "video/x-h265,stream-format=byte-stream,alignment=au"
                                     : "video/x-h264,stream-format=byte-stream,alignment=au";

        // Build compressed-video GStreamer pipeline.
        // appsrc delivers one complete H.264/H.265 access unit per buffer.
        // The audio element is named "audio_src" — matching the raw pipeline —
        // so the existing audio_appsrc member and audio-frame handler work unchanged.
        // See createPipeline() for why max-bytes needs leaky-type=downstream alongside it:
        // with block=false, appsrc otherwise queues without bound when decode/scale can't
        // keep up with the live NDI frame rate, which presents as a steady memory leak.
        const unsigned long comp_video_max_bytes = 16 * 1024 * 1024; // bound compressed appsrc queue
        const unsigned long audio_max_bytes = 1 * 1024 * 1024;       // ~1MB of PCM audio

        char pipeline_str[1536];
        snprintf(pipeline_str, sizeof(pipeline_str),
                 "appsrc name=comp_src format=time is-live=true block=false do-timestamp=true max-latency=0 "
                 "max-bytes=%lu leaky-type=downstream "
                 "caps=%s ! "
                 "queue max-size-buffers=4 max-size-time=0 max-size-bytes=0 leaky=downstream ! "
                 "%s ! %s ! videoconvert ! "
                 "videoscale method=%s add-borders=false ! "
                 "video/x-raw,width=%d,height=%d ! "
                 "autovideosink sync=false "
                 "appsrc name=audio_src format=time is-live=true block=false do-timestamp=true "
                 "max-bytes=%lu leaky-type=downstream "
                 "caps=audio/x-raw,format=S16LE,channels=2,rate=48000,layout=interleaved ! "
                 "queue ! audioconvert ! audioresample ! autoaudiosink sync=false",
                 comp_video_max_bytes,
                 video_caps,
                 parse_elem, decode_elem,
                 scale_method.c_str(),
                 display_width, display_height,
                 audio_max_bytes);

        GError *error = nullptr;
        comp_pipeline = gst_parse_launch(pipeline_str, &error);

        if (error)
        {
            std::cerr << "Compressed pipeline error: " << error->message << std::endl;
            g_error_free(error);
            return;
        }

        comp_pipeline_created = true;

        /**
         * Get audio element — reuse audio_appsrc member so the existing
         * audio-frame handler feeds audio into this compressed pipeline.
         * Then start the pipeline.
         */
        audio_appsrc = gst_bin_get_by_name(GST_BIN(comp_pipeline), "audio_src");
        gst_element_set_state(comp_pipeline, GST_STATE_PLAYING);
    }

    void start()
    {
        if (is_running)
            return;
        is_running = true;
        is_stalled = false;
        first_frame_logged = false;
        pipeline_created = false;

        // Run the GLib main loop so GStreamer can complete async state changes
        // (e.g. autovideosink preroll → PLAYING transition). Without this the
        // pipeline stalls after buffering the first frame.
        std::thread(&NDIReceiver::gstMainLoopThread, this).detach();

        // Start NDI receiving thread (will create pipeline when first frame arrives)
        std::thread(&NDIReceiver::receiveLoop, this).detach();

        std::cout << "- NDI Receiver started: " << current_source << std::endl;
    }

    void stop()
    {
        if (!is_running)
            return;
        is_running = false;

        // Stop the GLib main loop before tearing down pipelines
        if (main_loop && g_main_loop_is_running(main_loop))
            g_main_loop_quit(main_loop);

        if (pipeline)
        {
            gst_element_set_state(pipeline, GST_STATE_NULL);
            gst_object_unref(pipeline);
            pipeline = nullptr;
        }
        // The compressed (HX) pipeline was previously never torn down here,
        // so it leaked (kept running in the background) on every stop/reconnect
        // whenever the stream had used the HX path.
        if (comp_pipeline)
        {
            gst_element_set_state(comp_pipeline, GST_STATE_NULL);
            gst_object_unref(comp_pipeline);
            comp_pipeline = nullptr;
        }
        // Release audio_appsrc if it exists
        if (audio_appsrc)
        {
            gst_object_unref(audio_appsrc);
            audio_appsrc = nullptr;
        }
        pipeline_created = false;
        comp_pipeline_created = false;

        std::cout << "- NDI Receiver stopped" << std::endl;
    }

    void gstMainLoopThread()
    {
        g_main_loop_run(main_loop);
    }

private:
    void receiveLoop()
    {
        NDIlib_video_frame_v2_t video_frame;
        NDIlib_audio_frame_v3_t audio_frame;
        GstElement *appsrc = nullptr;
        GstElement *comp_appsrc = nullptr;
        auto last_data_time = std::chrono::steady_clock::now();

        while (is_running)
        {
            NDIlib_frame_type_e frame_type = NDIlib_frame_type_none;

            if (use_framesync)
            {
                // Framesync mode: capture video and audio separately
                // framesync_capture_video always returns immediately (returns void)
                g_ndi.framesync_capture_video(ndi_framesync, &video_frame, NDIlib_frame_format_type_progressive);

                // Check if we have valid video data
                if (video_frame.xres > 0 && video_frame.yres > 0)
                {
                    frame_type = NDIlib_frame_type_video;

                    // Also capture audio (48000 Hz, 2 channels, 2400 samples)
                    g_ndi.framesync_capture_audio_v2(ndi_framesync, &audio_frame, 48000, 2, 2400);
                }
                else
                {
                    // No video data yet
                    frame_type = NDIlib_frame_type_none;
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                }
            }
            else
            {
                // Standard receiver mode
                frame_type = g_ndi.recv_capture_v3(ndi_recv, &video_frame, &audio_frame, nullptr, 30);
            }

            switch (frame_type)
            {
            case NDIlib_frame_type_video:
            {
                last_data_time = std::chrono::steady_clock::now();

                // HX sources deliver compressed frames via NDIlib_frame_type_video with a
                // compressed FourCC (H264 / H265 / HEVC).  Detect this here and route to
                // the compressed pipeline; otherwise treat as raw UYVY.
                const uint32_t fcc = (uint32_t)video_frame.FourCC;
                const uint32_t fcc_h264 = NDI_LIB_FOURCC('H', '2', '6', '4');
                const uint32_t fcc_h265 = NDI_LIB_FOURCC('H', '2', '6', '5');
                const uint32_t fcc_hevc = NDI_LIB_FOURCC('H', 'E', 'V', 'C');
                const bool is_compressed = (fcc == fcc_h264 || fcc == fcc_h265 || fcc == fcc_hevc);
                const bool is_hevc = (fcc == fcc_h265 || fcc == fcc_hevc);

                if (is_compressed)
                {
                    // ----- Compressed (HX) path -----
                    bool needs_pipeline_update = !comp_pipeline_created ||
                                                 video_frame.xres != actual_comp_width ||
                                                 video_frame.yres != actual_comp_height ||
                                                 video_frame.frame_rate_N != actual_comp_rate_n ||
                                                 video_frame.frame_rate_D != actual_comp_rate_d ||
                                                 is_hevc != actual_comp_is_hevc;

                    if (needs_pipeline_update)
                    {
                        if (comp_appsrc)
                        {
                            gst_object_unref(comp_appsrc);
                            comp_appsrc = nullptr;
                        }
                        // createPipelineCompressed() also tears down the raw `pipeline`
                        // (a source can switch from raw to HX mid-stream), so the local
                        // `appsrc` ref to its now-destroyed appsrc must be dropped here too
                        // — otherwise it dangles until this thread exits.
                        if (appsrc)
                        {
                            gst_object_unref(appsrc);
                            appsrc = nullptr;
                        }

                        createPipelineCompressed(video_frame.xres, video_frame.yres,
                                                 video_frame.frame_rate_N, video_frame.frame_rate_D,
                                                 is_hevc);

                        if (comp_pipeline)
                        {
                            comp_appsrc = gst_bin_get_by_name(GST_BIN(comp_pipeline), "comp_src");
                        }

                        if (!first_frame_logged)
                        {
                            std::cout << "- Connected to: " << current_source << " (HX)" << std::endl;
                            first_frame_logged = true;
                        }
                    }

                    if (is_stalled)
                    {
                        is_stalled = false;
                        std::cout << "- Reconnected to: " << current_source << " (HX)" << std::endl;
                        std::flush(std::cout);
                    }

                    if (comp_appsrc)
                    {
                        gsize data_size = video_frame.data_size_in_bytes;
                        GstBuffer *buffer = gst_buffer_new_allocate(nullptr, data_size, nullptr);

                        GstMapInfo map;
                        gst_buffer_map(buffer, &map, GST_MAP_WRITE);
                        memcpy(map.data, video_frame.p_data, data_size);
                        gst_buffer_unmap(buffer, &map);

                        GstFlowReturn ret;
                        g_signal_emit_by_name(comp_appsrc, "push-buffer", buffer, &ret);
                        gst_buffer_unref(buffer);
                    }
                }
                else
                {
                    // ----- Raw (UYVY) path -----
                    bool needs_pipeline_update = !pipeline_created ||
                                                 video_frame.xres != actual_frame_width ||
                                                 video_frame.yres != actual_frame_height ||
                                                 video_frame.frame_rate_N != actual_frame_rate_n ||
                                                 video_frame.frame_rate_D != actual_frame_rate_d;

                    if (needs_pipeline_update)
                    {
                        if (appsrc)
                        {
                            gst_object_unref(appsrc);
                            appsrc = nullptr;
                        }
                        // createPipeline() also tears down `comp_pipeline` (a source can
                        // switch from HX to raw mid-stream), so the local `comp_appsrc`
                        // ref to its now-destroyed appsrc must be dropped here too —
                        // otherwise it dangles until this thread exits.
                        if (comp_appsrc)
                        {
                            gst_object_unref(comp_appsrc);
                            comp_appsrc = nullptr;
                        }

                        createPipeline(video_frame.xres, video_frame.yres,
                                       video_frame.frame_rate_N, video_frame.frame_rate_D);

                        if (pipeline)
                        {
                            appsrc = gst_bin_get_by_name(GST_BIN(pipeline), "ndi_src");
                        }

                        source_width = video_frame.xres;
                        source_height = video_frame.yres;
                        frame_rate = (double)video_frame.frame_rate_N / (double)video_frame.frame_rate_D;

                        if (!first_frame_logged)
                        {
                            std::cout << "- Connected to: " << current_source << std::endl;
                            first_frame_logged = true;
                        }
                    }

                    if (is_stalled)
                    {
                        is_stalled = false;
                        std::cout << "- Reconnected to: " << current_source << std::endl;
                        std::flush(std::cout);
                    }

                    if (appsrc)
                    {
                        gsize frame_size = video_frame.yres * video_frame.line_stride_in_bytes;
                        GstBuffer *buffer = gst_buffer_new_allocate(nullptr, frame_size, nullptr);

                        GstMapInfo map;
                        gst_buffer_map(buffer, &map, GST_MAP_WRITE);
                        memcpy(map.data, video_frame.p_data, frame_size);
                        gst_buffer_unmap(buffer, &map);

                        GstFlowReturn ret;
                        g_signal_emit_by_name(appsrc, "push-buffer", buffer, &ret);
                        if (ret != GST_FLOW_OK)
                        {
                            std::cerr << "Video push-buffer failed: " << gst_flow_get_name(ret) << std::endl;
                        }
                        gst_buffer_unref(buffer);
                    }
                }

                if (use_framesync)
                {
                    g_ndi.framesync_free_video(ndi_framesync, &video_frame);
                }
                else
                {
                    g_ndi.recv_free_video_v2(ndi_recv, &video_frame);
                }
                break;
            }
            case NDIlib_frame_type_audio:
            {
                last_data_time = std::chrono::steady_clock::now();

                if (audio_appsrc)
                {
                    // NDI audio is 32-bit float PLANAR (FourCC=FLTP) — must convert to
                    // 16-bit INTERLEAVED to match GStreamer caps (S16LE, layout=interleaved).
                    // util_audio_to_interleaved_16s_v3 handles NDIlib_audio_frame_v3_t directly.
                    NDIlib_audio_frame_interleaved_16s_t audio_16s;
                    audio_16s.sample_rate = audio_frame.sample_rate;
                    audio_16s.no_channels = audio_frame.no_channels;
                    audio_16s.no_samples = audio_frame.no_samples;
                    audio_16s.timecode = audio_frame.timecode;
                    audio_16s.reference_level = 0;

                    gsize buffer_size = audio_frame.no_samples * audio_frame.no_channels * sizeof(short);
                    audio_16s.p_data = (short *)malloc(buffer_size);

                    // NDI SDK v6 utility: float planar → interleaved 16-bit PCM
                    g_ndi.util_audio_to_interleaved_16s_v3(&audio_frame, &audio_16s);

                    // Create GStreamer buffer from converted data
                    GstBuffer *buffer = gst_buffer_new_allocate(nullptr, buffer_size, nullptr);
                    GstMapInfo map;
                    gst_buffer_map(buffer, &map, GST_MAP_WRITE);
                    memcpy(map.data, audio_16s.p_data, buffer_size);
                    gst_buffer_unmap(buffer, &map);

                    free(audio_16s.p_data);

                    // Push buffer to pipeline
                    GstFlowReturn ret;
                    g_signal_emit_by_name(audio_appsrc, "push-buffer", buffer, &ret);
                    if (ret != GST_FLOW_OK)
                    {
                        std::cerr << "Audio push-buffer failed: " << gst_flow_get_name(ret) << std::endl;
                    }
                    gst_buffer_unref(buffer);
                }

                if (use_framesync)
                {
                    g_ndi.framesync_free_audio_v2(ndi_framesync, &audio_frame);
                }
                else
                {
                    g_ndi.recv_free_audio_v3(ndi_recv, &audio_frame);
                }
                break;
            }
            // case NDIlib_frame_type_compressed_video: {
            //     // NDI HX compressed video (H.264 / H.265)
            //     // Determine codec from FourCC: 'H265' or 'HEVC' → H.265, otherwise H.264
            //     const uint32_t fcc_h265 = NDI_LIB_FOURCC('H', '2', '6', '5');
            //     const uint32_t fcc_hevc = NDI_LIB_FOURCC('H', 'E', 'V', 'C');
            //     bool is_hevc = ((uint32_t)video_frame.FourCC == fcc_h265 ||
            //                    (uint32_t)video_frame.FourCC == fcc_hevc);

            //     bool needs_pipeline_update = !comp_pipeline_created ||
            //         video_frame.xres         != actual_comp_width   ||
            //         video_frame.yres         != actual_comp_height  ||
            //         video_frame.frame_rate_N != actual_comp_rate_n  ||
            //         video_frame.frame_rate_D != actual_comp_rate_d  ||
            //         is_hevc                  != actual_comp_is_hevc;

            //     if (needs_pipeline_update) {
            //         // Release previous comp_appsrc reference
            //         if (comp_appsrc) {
            //             gst_object_unref(comp_appsrc);
            //             comp_appsrc = nullptr;
            //         }

            //         createPipelineCompressed(video_frame.xres, video_frame.yres,
            //                                  video_frame.frame_rate_N, video_frame.frame_rate_D,
            //                                  is_hevc);

            //         if (comp_pipeline) {
            //             comp_appsrc = gst_bin_get_by_name(GST_BIN(comp_pipeline), "comp_src");
            //         }

            //         if (!first_frame_logged) {
            //             std::cout << "- Connected to: " << current_source << " (HX)" << std::endl;
            //             first_frame_logged = true;
            //         }
            //     }

            //     if (comp_appsrc) {
            //         // data_size_in_bytes: total size of the compressed bitstream in p_data
            //         gsize data_size = video_frame.data_size_in_bytes;
            //         GstBuffer *buffer = gst_buffer_new_allocate(nullptr, data_size, nullptr);

            //         GstMapInfo map;
            //         gst_buffer_map(buffer, &map, GST_MAP_WRITE);
            //         memcpy(map.data, video_frame.p_data, data_size);
            //         gst_buffer_unmap(buffer, &map);

            //         GstFlowReturn ret;
            //         g_signal_emit_by_name(comp_appsrc, "push-buffer", buffer, &ret);
            //         gst_buffer_unref(buffer);
            //     }

            //     g_ndi.recv_free_video_v2(ndi_recv, &video_frame);
            //     break;
            // }
            // case NDIlib_frame_type_source_change: {
            //     // v6: the upstream source has changed (e.g. reconnected with different params)
            //     std::cout << "- NDI source changed, reconnecting..." << std::endl;
            //     std::flush(std::cout);
            //     break;
            // }
            case NDIlib_frame_type_none:
            {
                auto current_time = std::chrono::steady_clock::now();
                auto since_last_frame = std::chrono::duration_cast<std::chrono::milliseconds>(current_time - last_data_time);

                if (since_last_frame.count() >= 1000)
                {
                    static auto last_print_time = current_time;
                    auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(current_time - last_print_time);

                    if (elapsed.count() >= 2)
                    {
                        std::cout << "NDI_Source_Not_Active^true" << std::endl;
                        std::flush(std::cout);
                        last_print_time = current_time;
                        is_stalled = true;
                    }
                }
                break;
            }
            }
        }

        if (appsrc)
        {
            gst_object_unref(appsrc);
        }
        if (comp_appsrc)
        {
            gst_object_unref(comp_appsrc);
        }
    }
};

// Global receiver instance
NDIReceiver *g_receiver = nullptr;

void signalHandler(int sig)
{
    std::cout << "\nShutting down..." << std::endl;
    if (g_receiver)
    {
        g_receiver->stop();
        delete g_receiver;
        g_receiver = nullptr;
    }
    g_ndi.unloadLibrary();
    exit(0);
}

int main(int argc, char *argv[])
{

    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Load NDI library dynamically
    if (!g_ndi.loadLibrary())
    {
        std::cerr << "Failed to load NDI library. Please ensure NDI SDK v6 is installed." << std::endl;
        return 1;
    }

    std::string version = "NDPi Receiver [GStreamer] (4.1.0)";
    std::string source_name = "";
    NDIlib_recv_bandwidth_e bandwidth = NDIlib_recv_bandwidth_max;
    NDIlib_recv_color_format_e color_format = NDIlib_recv_color_format_fastest;
    bool use_framesync = false;
    std::string scale_method = "bilinear";

    for (int i = 1; i < argc; ++i)
    {
        std::string arg = argv[i];

        if (arg == "-s" || arg == "--source")
        {
            if (i + 1 < argc)
            {
                source_name = argv[++i];
            }
        }
        else if (arg == "-b" || arg == "--bandwidth")
        {
            if (i + 1 < argc)
            {
                bandwidth = (NDIlib_recv_bandwidth_e)std::stol(argv[++i], nullptr, 0);
            }
        }
        else if (arg == "-c" || arg == "--color-format")
        {
            if (i + 1 < argc)
            {
                color_format = (NDIlib_recv_color_format_e)std::stol(argv[++i], nullptr, 0);
            }
        }
        else if (arg == "-f" || arg == "--framesync")
        {
            use_framesync = true;
        }
        else if (arg == "-S" || arg == "--scale-method")
        {
            if (i + 1 < argc)
            {
                scale_method = argv[++i];
            }
        }
        else if (arg == "-v" || arg == "--version")
        {
            std::cout << version << std::endl;
            std::cout << g_ndi.version() << std::endl;
            return 0;
        }
        else if (arg == "-h" || arg == "--help")
        {
            std::cout << "\nUsage: " << argv[0] << "[OPTIONS]\n";
            std::cout << "[OPTIONS]:\n";
            std::cout << "    [-s|--source [<SOURCE NAME>]] --------------- NDI source name to open.               " << "\n";
            std::cout << "    [-b|--bandwidth [<OPTION>]] ----------------- Bandwidth ENUM  (Default: '0x7fffffff')" << "\n";
            std::cout << "                                                  [OPTIONS]:                             " << "\n";
            std::cout << "                                                      '-10'        -> metadata_only      " << "\n";
            std::cout << "                                                      '10'         -> audio_only         " << "\n";
            std::cout << "                                                      '0'          -> lowest             " << "\n";
            std::cout << "                                                      '100'        -> highest            " << "\n";
            std::cout << "                                                      '0x7fffffff' -> max                " << "\n";
            std::cout << "                                                                                         " << "\n";
            std::cout << "    [-c|--color-format [<OPTION>]] -------------- Color Format ENUM  (Default: '100')    " << "\n";
            std::cout << "                                                  [OPTIONS]:                             " << "\n";
            std::cout << "                                                      '0'   -> BGRX_BGRA                 " << "\n";
            std::cout << "                                                      '1'   -> UYVY_BGRA                 " << "\n";
            std::cout << "                                                      '2'   -> RGBX_RGBA                 " << "\n";
            std::cout << "                                                      '3'   -> UYVY_RGBA                 " << "\n";
            std::cout << "                                                      '100' -> fastest                   " << "\n";
            std::cout << "                                                      '101' -> best                      " << "\n";
            std::cout << "                                                                                         " << "\n";
            std::cout << "    [-f|--framesync] ---------------------------- Enable frame-synchronized receiver.    " << "\n";
            std::cout << "    [-S|--scale-method [<OPTION>]] -------------- GStreamer videoscale method.           " << "\n";
            std::cout << "                                                         (Default: 'bilinear')           " << "\n";
            std::cout << "                                                  [OPTIONS]:                             " << "\n";
            std::cout << "                                                      nearest                            " << "\n";
            std::cout << "                                                      linear                             " << "\n";
            std::cout << "                                                      cubic                              " << "\n";
            std::cout << "                                                      lanczos                            " << "\n";
            std::cout << "                                                      bilinear                           " << "\n";
            std::cout << "    [-v|--version] ------------------------------ NDPi Receiver Version.                 " << "\n";
            std::cout << "    [-h|--help] --------------------------------- This help menu.                        " << std::endl;

            return 0;
        }
    }

    std::cout << "- NDPi - Custom NDI Tools (" << __FILE_NAME__ << ")" << std::endl;
    std::cout << "- " << g_ndi.version() << std::endl;

    // if (argc > 1) {
    //     source_name = argv[1];
    // }
    // if (argc > 2) {
    //     bandwidth = (NDIlib_recv_bandwidth_e)std::stol(argv[2], nullptr, 0);
    // }
    // if (argc > 3) {
    //     color_format = (NDIlib_recv_color_format_e)std::stol(argv[3], nullptr, 0);
    // }

    try
    {
        g_receiver = new NDIReceiver(bandwidth, color_format, use_framesync, scale_method);

        // if (argc > 1) {
        if (!source_name.empty())
        {
            // std::string source_name = argv[1];
            std::cout << "- Connecting to source: " << source_name << std::endl;

            if (g_receiver->connectToSource(source_name))
            {
                g_receiver->start();

                // Keep running
                while (true)
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            }
            else
            {
                std::cerr << "Failed to connect to source: " << source_name << std::endl;
                g_ndi.unloadLibrary();
                return 1;
            }
        }
        // else {
        //     std::cout << "- NDI Receiver ready. Waiting for source..." << std::endl;
        //     // Keep running for commands
        //     while (true) {
        //         std::this_thread::sleep_for(std::chrono::milliseconds(100));
        //     }
        // }
    }
    catch (const std::exception &e)
    {
        std::cerr << "Error: " << e.what() << std::endl;
        g_ndi.unloadLibrary();
        return 1;
    }

    g_ndi.unloadLibrary();
    return 0;
}