{
  description = "Perun Analytics — Logos Basecamp ui_qml module (C++ backend + QML view)";

  inputs = {
    logos-module-builder.url = "github:logos-co/logos-module-builder";
    # Delivery dependency is added in the next iteration (must match
    # metadata.json "dependencies"):
    # delivery_module.url = "github:logos-co/logos-delivery-module";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
