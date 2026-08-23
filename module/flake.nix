{
  description = "Perun Analytics — Logos Basecamp ui_qml module (C++ backend + QML view)";

  inputs = {
    # perun now depends on the loam_core FACADE (not delivery_module directly): it moves
    # sealed CHUNKs through loam_core, which owns the delivery node (+ future ble_mesh) and
    # SDS Reliable Channels. One module-builder across all of them (loam_core's delivery
    # follows it too) = one SDK ABI. Same pins kym_core/qaku_core use (ADR 0015).
    loam_core.url = "github:vpavlin/loam-basecamp?dir=core";
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.2.6";
    loam_core.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
