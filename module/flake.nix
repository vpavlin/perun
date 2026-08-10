{
  description = "Perun Analytics — Logos Basecamp ui_qml module (C++ backend + QML view)";

  inputs = {
    # Channels-capable delivery_module (SDS Reliable Channels) — the same rev
    # kym_core builds against. Full 40-char SHA pin: branch urls 422 the moment
    # the SDK branch is renamed/deleted (see logos-basecamp-module skill).
    delivery_module.url = "github:logos-co/logos-delivery-module/0fb3a7427b29c98ab0fa2465bcd1e90cbfdf50a3";
    # Builder that emits the channels binding — same rev kym_core uses.
    logos-module-builder.url = "github:logos-co/logos-module-builder/afe4430ee6eb7ba45c08a516a43e18500720c715";
    delivery_module.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
