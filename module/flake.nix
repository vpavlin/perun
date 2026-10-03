{
  description = "Perun Analytics — Logos Basecamp ui_qml VIEW over perun_core (ADR 0006).";

  inputs = {
    # port/0.3: builder 0.3.1 — the same builder as perun_core and loam_core (one SDK).
    logos-module-builder.url = "github:logos-co/logos-module-builder/0.3.1";
    perun_core.url = "github:vpavlin/perun/17d9d813e2196dc4f94b4cd5c7aab54059d6ba35?dir=core";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
