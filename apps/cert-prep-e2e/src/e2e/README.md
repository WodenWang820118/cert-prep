# Cert Prep E2E levels

- `local-package/`: the checked-out application and local real-backend/runtime
  topology. The smoke and real-backend suites use real servers and own their
  cleanup.
- `online-package/`: reserved for an explicitly pinned online package. No
  online case is enabled in this checkout.
- `../support/`: shared browser fixtures and route helpers; it is not a test
  suite by itself.
