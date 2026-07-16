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
# libQt6Network ships inside the qtbase already in the closure, so this adds no
# new nix input — logos_module() only links Qt::Core + Qt::RemoteObjects, so we
# resolve the Network imported target here and pass it via LINK_LIBRARIES below.
find_package(Qt6 REQUIRED COMPONENTS Network)

# Universal UI module: you write the .rep + the *Backend class. REP_FILE runs
# repc; the generated *Plugin glue in generated_code/ is compiled automatically.
logos_module(
    NAME ${MODULE_NAME}
    REP_FILE src/perun_analytics.rep
    SOURCES
        src/perun_analytics_backend.h
        src/perun_analytics_backend.cpp
        src/perun_identity.h
        src/perun_identity.cpp
        src/pgp_words.h
        src/qrcodegen.hpp
        src/qrcodegen.cpp
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
