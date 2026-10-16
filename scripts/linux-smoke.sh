#!/bin/bash
# Installs a packed agenterm CLI the way a Linux user would (npm 12, no flags)
# and checks terminals, ports, and commands left running outside agenterm.
# Runs inside a container, so the orphan it makes is adopted by its init:
#
#   (cd apps/cli && npm pack) && docker run --rm --init -v "$PWD:/repo" node:24-bookworm \
#     /repo/scripts/linux-smoke.sh /repo/apps/cli/agenterm-<version>.tgz
set -euo pipefail
echo "linux smoke: $(uname -m), node $(node -v)"
npm install -g npm@12 >/dev/null 2>&1
npm install -g "$1"
export AGENTERM_DATA_DIR=/tmp/agenterm AGENTERM_PORT=37400

agenterm run --id hello "echo linux-pty-ok" >/dev/null
sleep 1
agenterm logs hello | grep -q linux-pty-ok
agenterm run --id web -C /tmp "python3 -m http.server 9200" >/dev/null
sleep 3
agenterm ls | grep web | grep -q ':9200'

# A server left behind by a shell that exited.
mkdir -p /tmp/site && cd /tmp/site
sh -c 'python3 -m http.server 9123 >/dev/null 2>&1 &'
sleep 3
agenterm ps
pid=$(agenterm ps --orphaned --json | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const found = JSON.parse(s).find((p) => p.command.includes("http.server 9123") && p.ports.includes(9123));
    console.log(found ? found.pid : "");
  });')
test -n "$pid" || { echo "the orphaned server is missing from agenterm ps"; exit 1; }
agenterm kill "$pid"
agenterm daemon stop
echo "linux smoke ok"
