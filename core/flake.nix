{
  description = "Perun Core — headless Logos engine+sync module (identity, Delivery transport, run+annotation fold, media hub). The always-on hub AND the perun_analytics view's backend.";

  inputs = {
    # port/0.3: builder 0.3.1; perun_core rides the loam_core facade on UPSTREAM delivery v0.3.0.
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    loam_core.url = "github:vpavlin/loam-basecamp/553253fee586baeb16d84c77e3f6da543ba7de9b?dir=core";
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
