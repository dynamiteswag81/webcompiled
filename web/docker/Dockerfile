# WiiCompiled web host: everything needed to translate + compile + serve the browser build.
#
#   docker compose up          (from the repository root; see compose.yaml)
#
# The image holds tools and this repository only. Game files are mounted at /game at run time,
# and every build output lives on the /cache volume. No game data is ever baked into the image.
FROM mcr.microsoft.com/dotnet/sdk:8.0

ARG EMSCRIPTEN_VERSION=6.0.12
# Keep in step with NODTOOL_VERSION in web/build.sh.
ARG NODTOOL_VERSION=v2.0.0-alpha.10
# Optional: a commit id for the build fingerprint. Without it a hash of the source tree is used.
ARG REPO_COMMIT=

ENV DEBIAN_FRONTEND=noninteractive \
    DOTNET_NOLOGO=1 \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_CLI_HOME=/cache/dotnet \
    NUGET_PACKAGES=/cache/nuget \
    EMSDK=/emsdk \
    EM_CACHE=/cache/emscripten-cache \
    MKW_CACHE_DIR=/cache \
    MKW_REPO_DIR=/opt/wiicompiled \
    PORT=8080

# Build tools (Debian 12 ships CMake 3.25, the minimum the build needs).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 cmake ninja-build git xz-utils ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Emscripten (emsdk is cloned only to install; its history and download cache are dropped).
RUN git clone --depth 1 https://github.com/emscripten-core/emsdk /emsdk \
 && cd /emsdk \
 && ./emsdk install "${EMSCRIPTEN_VERSION}" \
 && ./emsdk activate "${EMSCRIPTEN_VERSION}" \
 && rm -rf /emsdk/.git /emsdk/zips /emsdk/downloads

# nodtool: the disc extractor the native setup also uses (a release asset, not a source archive).
RUN case "$(uname -m)" in \
      x86_64)  asset=nodtool-linux-x86_64 ;; \
      aarch64) asset=nodtool-linux-aarch64 ;; \
      *) echo "no prebuilt nodtool for $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/nodtool "https://github.com/encounter/nod/releases/download/${NODTOOL_VERSION}/${asset}" \
 && chmod +x /usr/local/bin/nodtool

COPY . /opt/wiicompiled
WORKDIR /opt/wiicompiled

# Version stamp for the build fingerprint (the repository history is not in the image).
RUN if [ -n "${REPO_COMMIT}" ]; then printf '%s' "${REPO_COMMIT}" > .repo-commit; \
    else find . -type f ! -name .repo-commit -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1 > .repo-commit; fi

VOLUME /cache
EXPOSE 8080
ENTRYPOINT ["/opt/wiicompiled/web/docker/entrypoint.sh"]
