#!/usr/bin/env bash
# Runs the Windows build-script checks that do not need Windows, inside PowerShell 7 in Docker
# (or a local `pwsh` when Docker is not wanted: PWSH=pwsh web/windows/tests/run-tests.sh).
#
#   1. Test-Ps51Compat.ps1  - parse every script and lint for PowerShell 6/7-only syntax and APIs
#   0. check_bat.py         - build.bat byte/structure checks (CRLF, ASCII, quoting, labels)
#   2. Test-Lib.ps1         - hashes, resume/skip, game detection, step messages, with a local HTTP server
#
# Windows PowerShell 5.1 itself exists only on Windows; see the checklist in the build report.
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
image=${PWSH_IMAGE:-mcr.microsoft.com/powershell:latest}

run() {
    if [[ -n "${PWSH:-}" ]]; then
        "$PWSH" -NoProfile -File "$repo/web/windows/tests/$1" "${@:2}"
    else
        # Python (for web/serve.py as the local test server) is installed on demand in the throwaway container.
        docker run --rm -v "$repo":/repo "$image" bash -c \
            "command -v python3 >/dev/null || (apt-get update -qq && apt-get install -y -qq python3 >/dev/null); pwsh -NoProfile -File /repo/web/windows/tests/$1 ${*:2}"
    fi
}

status=0
python3 -I "$repo/web/windows/tests/check_bat.py" || status=1
run Test-Ps51Compat.ps1 || status=1
run Test-Lib.ps1 || status=1
exit $status
