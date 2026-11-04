# cert-prep-ollama

Ollama infrastructure utilities shared across cert-prep projects. Provides executable resolution, server lifecycle management, model helpers, and runtime installers.

GPU selection for the Ollama server Cert Prep starts: `device_policy.py` picks a dedicated GPU, else an integrated GPU through Vulkan, else CPU, and exposes only that adapter to the server; `server_log.py` and `device_verification.py` check where each model actually loads; `server_coordinator.py` owns at most one server per app and restarts it once on a mismatch. An Ollama that was already running is treated as external and never stopped or reconfigured.
