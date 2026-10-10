#!/usr/bin/env bash
# Container entrypoint: keep every build output on the /cache volume, then run web/host.sh
# against the read-only /game mount. Extra arguments go to host.sh (e.g. --rebuild, --jobs 2).
set -euo pipefail

repo=${MKW_REPO_DIR:-/opt/wiicompiled}
cache=${MKW_CACHE_DIR:-/cache}

link() { # link <path relative to the repo> into the cache volume
    local rel=$1
    mkdir -p "$cache/$rel" "$(dirname "$repo/$rel")"
    if [[ ! -L "$repo/$rel" ]]; then rm -rf "${repo:?}/$rel"; ln -s "$cache/$rel" "$repo/$rel"; fi
}

for dir in generated Assets build PulsarPacks web/build web/dist; do link "$dir"; done
# .NET build outputs of every translator project
while IFS= read -r proj; do
    dir=$(dirname "${proj#"$repo"/}")
    link "$dir/bin"
    link "$dir/obj"
done < <(find "$repo/translator" -name '*.csproj' 2>/dev/null)

mkdir -p "$cache/emscripten-cache" "$cache/nuget" "$cache/dotnet"

cd "$repo"
exec web/host.sh --game "${MKW_GAME_DIR:-/game}" "$@"
