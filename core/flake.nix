{
  description = "Perun Core — headless Logos engine+sync module (identity, Delivery transport, run+annotation fold, media hub). The always-on hub AND the perun_analytics view's backend.";

  inputs = {
    # Same shape as kym_core/scala: the core rides the loam_core FACADE (not
    # delivery_module directly) — sealed bytes move through loam_core, which owns the
    # delivery node (+ future ble_mesh) and SDS Reliable Channels. One module-builder
    # across all of them (loam_core's delivery follows it too) = one SDK ABI.
    loam_core.url = "path:/home/vpavlin/loam-basecamp/core";
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.2.6";
    loam_core.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  # mkLogosModule (not mkLogosQmlModule): a headless core module — no QML view. The
  # plugin glue + the modules().perun_core proxy for dependents are generated from the
  # public methods of PerunCoreImpl (universal authoring).
  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
