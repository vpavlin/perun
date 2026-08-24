cmake_minimum_required(VERSION 3.14)
project(PerunAnalyticsPlugin LANGUAGES CXX)

if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")
endif()

# Derive the module name from metadata.json — single source of truth.
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/metadata.json" METADATA_JSON)
string(JSON MODULE_NAME GET ${METADATA_JSON} name)

# Qt Network for the OSM raster tile fetcher (PerunAnalyticsBackend::ensureTile).
# libQt6Network ships inside qtbase already in the closure.
find_package(Qt6 REQUIRED COMPONENTS Network)

# Thin ui_qml VIEW (ADR 0006): the .rep + the *Backend proxy. All engine/sync
# logic lives in perun_core; this module only mirrors its snapshot into the PROPs
# and owns the sandbox-coupled tiles / QR / media caching. So the only sources are
# the backend + the vendored QR encoder — no crypto/store/gpx here.
logos_module(
    NAME ${MODULE_NAME}
    REP_FILE src/perun_analytics.rep
    SOURCES
        src/perun_analytics_backend.h
        src/perun_analytics_backend.cpp
        src/qrcodegen.hpp
        src/qrcodegen.cpp
    INCLUDE_DIRS
        src
    LINK_LIBRARIES
        Qt6::Network
)
