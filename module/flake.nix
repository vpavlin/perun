{
  description = "Perun Analytics — Logos Basecamp ui_qml VIEW over perun_core (ADR 0006).";

  inputs = {
    # The view is a thin proxy over the headless perun_core: it declares perun_core
    # as its dependency so the builder generates the modules().perun_core proxy the
    # backend calls. Build locally with --override-input perun_core path:../core
    # (perun_core follows the same module-builder pin so the SDK ABI matches).
    perun_core.url = "github:vpavlin/perun?dir=core";
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.2.6";
    perun_core.inputs.logos-module-builder.follows = "logos-module-builder";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
