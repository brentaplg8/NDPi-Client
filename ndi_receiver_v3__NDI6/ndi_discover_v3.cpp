/**
 * NDPi Discover - NDI SDK v6 with Dynamic Library Loading
 * 
 * Features:
 * - NDI SDK v6 support with dynamic library loading
 * - No compile-time NDI SDK linking required
 * - Discovers all available NDI sources on the network
 * - Outputs results in JSON format for easy parsing
 * 
 * Compilation:
 *   g++ -o ndi_discover_v3 ndi_discover_v3.cpp -I"/opt/NDI SDK for Linux/include" -ldl -std=c++11
 *   g++ -o ndpi_discover ndi_discover_v3.cpp -I"include" -ldl -std=c++11
 * 
 */

#include <cstdio>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>
#include <string>
#include <signal.h>
#include <dlfcn.h>
#include "Processing.NDI.Lib.h"


// NDI SDK v6 Dynamic Loading
struct NDILib {
    void* handle = nullptr;
    
    // Function pointers for NDI SDK v6
    bool (*initialize)(void) = nullptr;
    void (*destroy)(void) = nullptr;
    const char* (*version)(void) = nullptr;
    
    // Finder functions
    NDIlib_find_instance_t (*find_create_v2)(const NDIlib_find_create_t* p_create_settings) = nullptr;
    void (*find_destroy)(NDIlib_find_instance_t p_instance) = nullptr;
    bool (*find_wait_for_sources)(NDIlib_find_instance_t p_instance, uint32_t timeout_in_ms) = nullptr;
    const NDIlib_source_t* (*find_get_current_sources)(NDIlib_find_instance_t p_instance, uint32_t* p_no_sources) = nullptr;
    
    bool loadLibrary() {
        // Try to load NDI library from common locations
        const char* lib_paths[] = {
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so.6",   // Local v6
            "lib/aarch64-rpi4-linux-gnueabi/libndi.so",     // Local dir
            "/usr/local/lib/libndi.so.6",                   // Linux v6 alt
            "/usr/local/lib/libndi.so",                     // Linux alt fallback
            "/usr/local/lib/libndi.dylib",                  // macOS Homebrew
            "/opt/homebrew/lib/libndi.dylib",               // macOS M1/M2 Homebrew
            "/usr/lib/libndi.so",                           // Linux fallback
            "libndi.dylib",                                 // macOS system
            "libndi.so.6",                                  // Linux v6 system
            "libndi.so",                                    // Linux system fallback
            nullptr
        };
        
        for (int i = 0; lib_paths[i] != nullptr; i++) {
            handle = dlopen(lib_paths[i], RTLD_LAZY | RTLD_LOCAL);
            if (handle) {
                // std::cout << "Loaded NDI library from: " << lib_paths[i] << std::endl;
                break;
            }
        }
        
        if (!handle) {
            std::cerr << "Failed to load NDI library: " << dlerror() << std::endl;
            return false;
        }
        
        // Load function pointers
        #define LOAD_FUNC(name) \
            name = reinterpret_cast<decltype(name)>(dlsym(handle, "NDIlib_" #name)); \
            if (!name) { \
                std::cerr << "Failed to load NDIlib_" #name << ": " << dlerror() << std::endl; \
                dlclose(handle); \
                handle = nullptr; \
                return false; \
            }
        
        LOAD_FUNC(initialize);
        LOAD_FUNC(destroy);
        LOAD_FUNC(version);
        LOAD_FUNC(find_create_v2);
        LOAD_FUNC(find_destroy);
        LOAD_FUNC(find_wait_for_sources);
        LOAD_FUNC(find_get_current_sources);
        
        #undef LOAD_FUNC
        
        //std::cout << version() << std::endl;
        return true;
    }
    
    void unloadLibrary() {
        if (handle) {
            dlclose(handle);
            handle = nullptr;
        }
    }
};

NDILib g_ndi;

static volatile bool g_shutdown = false;

void signal_handler(int signum) {
    printf("\n");
    g_shutdown = true;
}

struct Options {
    std::string version = "NDPi Discover (3.0.20)";
    std::string separator = "^";
    int timeout = 5;
};

int main(int argc, char* argv[])
{
    
    if (!g_ndi.loadLibrary()) {
        std::cerr << "Failed to load NDI library. Please ensure NDI SDK v6 is installed." << std::endl;
        return 1;
    }
    
    if (!g_ndi.initialize()) {
        g_ndi.unloadLibrary();
        return 1;
    }

    NDIlib_find_instance_t pNDI_find = g_ndi.find_create_v2(nullptr);
    if (!pNDI_find) {
        g_ndi.destroy();
        g_ndi.unloadLibrary();
        return 1;
    }

    signal(SIGINT, signal_handler);
    signal(SIGTERM, signal_handler);

    Options options;

    int timeout_seconds = options.timeout;
    bool use_json = true;
    
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        
        if (arg == "-s" || arg == "--single-line") {
            use_json = false;
            if (i + 1 < argc) {
                options.separator = argv[++i];
            }
        } else if (arg == "-t" || arg == "--timeout") {
            if (i + 1 < argc) {
                timeout_seconds = std::atoi(argv[++i]);
            } else {
                std::cerr << "Error: " << arg << " requires a value." << std::endl;
                return 1;
            }
        } else if (arg == "-v" || arg == "--version") {
            std::cout << options.version << std::endl;
            std::cout << g_ndi.version() << std::endl;
            return 0;
        } 
        else if (arg == "-h" || arg == "--help") {
            std::cout << "Usage: " << argv[0] << "[OPTIONS]\n\n";
            std::cout << "[OPTIONS]:\n";
            std::cout << "    " << "[-s|--single-line [<separator>]]" << "\t" << "Outputs one(1) source per line. E.g.:'NAME<seperator>URL'. (Default: '^')\n";
            std::cout << "    " << "[-t|--timeout [<seconds>]]" << "\t\t" << "How long to search for available sources before giving up. (Default: 5)\n";
            // std::cout << "    " << "" << "\t\t" << "                              NOTE:  Increasing the '-timeout' will also increase the time it takes to shutdown.\n";
            std::cout << "    " << "[-v|--version]" << "\t\t\t" << "NDPi Discover Version.\n";
            std::cout << "    " << "[-h|--help]" << "\t\t\t\t" << "This help menu." << std::endl;

            return 0;
        } 
    }

    // static auto last_discovery_time = std::chrono::steady_clock::now() - std::chrono::seconds(5);
    // static bool output_pending = false;
    std::this_thread::sleep_for(std::chrono::seconds(3));

    while (!g_shutdown) {

        // auto current_time = std::chrono::steady_clock::now();
        
        if (g_ndi.find_wait_for_sources(pNDI_find, timeout_seconds * 1000)) {
        //     last_discovery_time = current_time;
        //     output_pending = false;
        // }

        // auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(current_time - last_discovery_time).count();

        // if (elapsed >= 1000 && !output_pending) {
        //     output_pending = true;

            timeout_seconds = 0;
            
            uint32_t no_sources = 0;
            const NDIlib_source_t* p_sources = g_ndi.find_get_current_sources(pNDI_find, &no_sources);

            if (use_json) {
                std::cout << "[";
            }
            for (uint32_t i = 0; i < no_sources; i++) {

                std::string source_name = p_sources[i].p_ndi_name ? p_sources[i].p_ndi_name : "";
                std::string source_url = p_sources[i].p_url_address ? p_sources[i].p_url_address : "";
                std::string obj_line_end = i < no_sources - 1 ? "," : "";

                if (use_json) {
                    std::cout << "{\"name\":\"" << source_name << "\",\"url\":\"" << source_url << "\"}" << obj_line_end;
                } else {
                    std::cout << source_name << options.separator << source_url << "\n";
                }
            }
            if (use_json) {
                std::cout << "]" << std::endl;
            }
        }
    }

    // Cleanup on shutdown
    g_ndi.find_destroy(pNDI_find);
    g_ndi.destroy();
    g_ndi.unloadLibrary();

    return 0;
}
