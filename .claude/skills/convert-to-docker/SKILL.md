---
name: convert-to-docker
description: "OBSOLETE: Container runtime is now auto-detected. NanoClaw supports both Apple Container and Docker via src/container-runtime.ts. Set CONTAINER_RUNTIME=docker env var or just install Docker — it will be detected automatically."
disable-model-invocation: true
---

# Convert to Docker — OBSOLETE

This skill is no longer needed. NanoClaw now auto-detects the container runtime:

1. If `CONTAINER_RUNTIME` env var is set → uses that (`apple-container` or `docker`)
2. Else probes `container --version` → Apple Container
3. Else probes `docker --version` → Docker (also covers OrbStack/Colima)

No code changes are required to switch runtimes. Just install Docker and NanoClaw will use it automatically.

See `src/container-runtime.ts` for the implementation.
