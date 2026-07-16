{
  description = "Perun Analytics — Logos Basecamp ui_qml module (C++ backend + QML view)";

  inputs = {
    # Core module dependencies — must match metadata.json "dependencies".
    delivery_module.url = "github:logos-co/logos-delivery-module/v0.1.3";
    # QR service for the pairing card (QrCard.qml → logos.callModule("qr",…)).
    # Pinned to v0.2.0 to match the qr LGX installed in Basecamp at runtime.
    qr.url = "github:xAlisher/qr-basecamp/v0.2.0";
    # Build perun with the SAME logos-module-builder (→ logos-qt-sdk) as qr and
    # the deployed 0.2.0 Basecamp (builder rev 021013458d87, 2026-06-17). perun's
    # previous builder was 2026-05-22, older than that SDK bump — its synchronous
    # cross-module callModule IPC didn't complete against the 0.2.0 ui-host, so
    # qr's `generateCard` returned empty and no QR rendered.
    logos-module-builder.follows = "qr/logos-module-builder";
  };

  outputs = inputs@{ logos-module-builder, ... }:
    logos-module-builder.lib.mkLogosQmlModule {
      src = ./.;
      configFile = ./metadata.json;
      flakeInputs = inputs;
    };
}
