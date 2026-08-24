cmake_minimum_required(VERSION 3.14)
project(PerunCorePlugin LANGUAGES CXX)

if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")
    include(cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")
endif()

# Derive the module name from metadata.json — single source of truth.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)
string(JSON MODULE_NAME GET ${METADATA_JSON} name)

# Qt Network for the embedded blob hub (PerunBlobServer / QTcpServer) and the
# media-blob GET in getMedia. libQt6Network ships inside qtbase already in the
# closure, so this adds no new nix input; logos_module() links Qt::Core, so we
# resolve the Network target here and pass it via LINK_LIBRARIES below.
find_package(Qt6 REQUIRED COMPONENTS Network)

# Headless CORE module (no REP_FILE): the API is the public methods of
# PerunCoreImpl (universal authoring); the generated *Plugin glue in
# generated_code/ is compiled automatically.
logos_module(
    NAME ${MODULE_NAME}
    SOURCES
        src/perun_core_impl.h
        src/perun_core_impl.cpp
        src/blob_server.h
        src/blob_server.cpp
        src/perun_identity.h
        src/perun_identity.cpp
        src/pgp_words.h
        src/run_store.h
        src/run_store.cpp
        src/geo.h
        src/gpx.h
        src/gzip.h
        src/run_analytics.h
    INCLUDE_DIRS
        src
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor/sqlite
    EXTERNAL_LIBS
        sqlite3
    FIND_PACKAGES
        ZLIB
        OpenSSL
    LINK_LIBRARIES
        ZLIB::ZLIB
        Qt6::Network
        OpenSSL::Crypto
)
