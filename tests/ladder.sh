#!/usr/bin/env bash
# Self-test for the generated supervisor. Runs the whole recovery ladder against
# stub commands in a scratch directory, so it never touches the real profile or
# the real systemd units.
#
#   bash tests/ladder.sh
#
# It covers:
#   1. rapid crash loop  -> safe mode + incident report
#   2. healthy run       -> failure ladder reset
#   3. clean exit        -> supervisor stops (no restart storm)
#   4. broken config     -> quarantine + restore from the known-good snapshot
set -uo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$PLUGIN_DIR/.selftest"
FAILED=0

render() {
  sed -e "s|@@HOME_DIR@@|$SCRATCH/home|g" \
      -e "s|@@NODE_BIN@@|/bin/bash|g" \
      -e "s|@@DSH_CLI@@|$SCRATCH/stub-cli.sh|g" \
      -e "s|@@DSH_HOME@@|$SCRATCH/dshhome|g" \
      -e "s|@@PROFILE@@|web|g" \
      -e "s|@@SAFE_PROFILE@@|dsh-safe|g" \
      -e "s|@@SAFE_TEMPLATE@@|web|g" \
      -e "s|@@APP_ARGS@@|--no-open --port 3999|g" \
      -e "s|@@UNIT_NAME@@|dsh-ian-daemon.service|g" \
      -e "s|@@FAIL_WINDOW@@|600|g" \
      -e "s|@@FAIL_THRESHOLD@@|3|g" \
      -e "s|@@HEALTHY_SECONDS@@|1|g" \
      -e "s|@@MAX_BACKOFF@@|2|g" \
      -e "s|@@NOTIFY@@|0|g" \
      "$PLUGIN_DIR/supervisor.sh"
}

check() { # description expected actual
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s (expected %s, got %s)\n' "$1" "$2" "$3"
    FAILED=1
  fi
}

# Wait until a shell condition holds (or the deadline passes). The recovery
# ladder is driven by backoff timers, so asserting after a fixed sleep is flaky.
await() { # shell-condition seconds
  local deadline=$(( $(date +%s) + $2 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    eval "$1" && return 0
    sleep 0.25
  done
  return 1
}

prepare() {  rm -rf "$SCRATCH"
  mkdir -p "$SCRATCH/home" "$SCRATCH/home/state" "$SCRATCH/dshhome/profiles/web"
  printf '#!/bin/bash\nsleep 0.2\nexit 1\n' >"$SCRATCH/fail.sh"
  printf '#!/bin/bash\nsleep 2\nexit 1\n' >"$SCRATCH/healthy.sh"
  printf '#!/bin/bash\nsleep 2\nexit 0\n' >"$SCRATCH/clean.sh"
  cat >"$SCRATCH/stub-cli.sh" <<EOF
#!/bin/bash
if grep -q BROKEN "$SCRATCH/dshhome/profiles/web/cordis.patch.yml" 2>/dev/null; then
  echo "stub-cli: YAMLException: broken profile config" >&2
  exit 1
fi
echo "[]"
exit 0
EOF
  chmod +x "$SCRATCH"/*.sh
  render >"$SCRATCH/supervisor.sh"
}

echo "1. rapid crash loop escalates to safe mode"
prepare
DSH_IAN_DAEMON_EXEC="$SCRATCH/fail.sh" DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)" = safe ]' 30
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
check "mode file says safe" "safe" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)"
check "an incident was recorded" "safe-mode" "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"
check "a report file exists" "1" "$(ls -1 "$SCRATCH/home/reports"/incident-*.md 2>/dev/null | wc -l)"

echo "2. a healthy run clears the failure ladder"
prepare
printf '2' >"$SCRATCH/home/state/failures"
printf '%s' "$(date +%s)" >"$SCRATCH/home/state/window_start"
printf 'normal' >"$SCRATCH/home/state/mode"
DSH_IAN_DAEMON_EXEC="$SCRATCH/healthy.sh" DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/failures" 2>/dev/null)" = 0 ]' 20
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
check "failures reset" "0" "$(cat "$SCRATCH/home/state/failures" 2>/dev/null)"

echo "3. a clean exit is restarted, never treated as a stop"
prepare
DSH_IAN_DAEMON_EXEC="$SCRATCH/clean.sh" DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 \
  timeout -s TERM 8 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "supervisor kept running until the timeout" "124" "$?"
check "it restarted instead of stopping" "yes" \
  "$(grep -q 'restarting anyway' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"

echo "4. a broken config is quarantined and restored"
prepare
mkdir -p "$SCRATCH/home/backup"
printf 'good-config\n' >"$SCRATCH/home/backup/cordis.patch.yml"
printf 'BROKEN-CONFIG\n' >"$SCRATCH/dshhome/profiles/web/cordis.patch.yml"
DSH_IAN_DAEMON_EXEC="$SCRATCH/clean.sh" timeout -s TERM 8 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "profile config restored" "good-config" "$(cat "$SCRATCH/dshhome/profiles/web/cordis.patch.yml" 2>/dev/null)"
check "broken config quarantined" "1" "$(ls -1d "$SCRATCH/home/reports"/broken-* 2>/dev/null | wc -l)"

echo "5. the relaunch helper waits for the old pid and re-executes"
prepare
( sleep 0.4 ) & old_pid=$!
bash "$PLUGIN_DIR/relaunch.sh" "$old_pid" exec "" "$SCRATCH" /bin/bash -c "echo relaunched >'$SCRATCH/relaunch-ok'"
check "helper exit code" "0" "$?"
check "command was re-executed" "relaunched" "$(cat "$SCRATCH/relaunch-ok" 2>/dev/null)"

echo "6. the relaunch helper fails fast when systemd cannot restart the unit"
bash "$PLUGIN_DIR/relaunch.sh" 1 systemd dsh-ian-daemon-does-not-exist.service "" /bin/true
check "helper exit code" "1" "$?"

echo "7. an instant exit 0 is a failed start, not a clean stop"
prepare
printf '#!/bin/bash\nsleep 0.2\nexit 0\n' >"$SCRATCH/exit0.sh"
chmod +x "$SCRATCH/exit0.sh"
DSH_IAN_DAEMON_EXEC="$SCRATCH/exit0.sh" DSH_IAN_DAEMON_HEALTHY_SECONDS=5 \
  DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
await '[ "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)" = safe ]' 30
kill -TERM "$SUP" 2>/dev/null
wait "$SUP" 2>/dev/null
RETRIES="$(grep -c 'treated as a failed start' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null | head -1)"
check "kept retrying instead of stopping" "yes" "$([ "${RETRIES:-0}" -ge 1 ] && echo yes || echo no)"
check "escalated to safe mode" "safe" "$(cat "$SCRATCH/home/state/mode" 2>/dev/null)"
check "incident kind" "safe-mode" \
  "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"

echo "8. an unusable generated command line is reported and never launched"
prepare
HOME="$SCRATCH/nohome" PATH=/usr/bin:/bin \
  DSH_IAN_DAEMON_NODE=/nonexistent/node DSH_IAN_DAEMON_CLI=/nonexistent/bin.js \
  DSH_IAN_DAEMON_NOTIFY=0 DSH_IAN_DAEMON_MAX_BACKOFF=1 \
  timeout -s TERM 5 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
LAUNCHED="$(grep -c 'start mode=' "$SCRATCH/home/logs/dsh.out.log" 2>/dev/null | head -1)"
check "nothing was launched" "0" "${LAUNCHED:-0}"
check "runtime-missing incident written" "runtime-missing" \
  "$(grep -o '"kind":"[a-z-]*"' "$SCRATCH/home/state/incident.json" 2>/dev/null | cut -d'"' -f4)"

echo "9. a stale generated command line is repaired from an installed layout"
prepare
FAKE="$SCRATCH/fakehome/.local/share/fnm/node-versions/v9.9.9/installation"
mkdir -p "$FAKE/bin" "$FAKE/lib/node_modules/@deepseek-ai/dsh/lib"
printf '#!/bin/bash\nexec /bin/bash "$@"\n' >"$FAKE/bin/node"
printf '#!/bin/bash\necho "fake dsh cli ran: $*" >>"%s"\nexit 0\n' "$SCRATCH/cli-ran.txt" >"$FAKE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
chmod +x "$FAKE/bin/node" "$FAKE/lib/node_modules/@deepseek-ai/dsh/lib/bin.js"
HOME="$SCRATCH/fakehome" PATH=/usr/bin:/bin \
  DSH_IAN_DAEMON_NODE=/nonexistent/node DSH_IAN_DAEMON_CLI=/nonexistent/bin.js \
  DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 DSH_IAN_DAEMON_HEALTHY_SECONDS=0 \
  timeout -s TERM 5 bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1
check "repaired from the installed layout" "yes" \
  "$(grep -q 'runtime repaired' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"
check "the repaired command really ran" "yes" \
  "$(grep -q 'fake dsh cli ran' "$SCRATCH/cli-ran.txt" 2>/dev/null && echo yes || echo no)"

echo "10. a stop signal (systemctl stop) ends the supervisor promptly"
prepare
DSH_IAN_DAEMON_EXEC="sleep 30" DSH_IAN_DAEMON_SKIP_PREFLIGHT=1 DSH_IAN_DAEMON_SKIP_SAFE_PROFILE=1 \
  bash "$SCRATCH/supervisor.sh" >/dev/null 2>&1 &
SUP=$!
sleep 1
kill -TERM "$SUP"
wait "$SUP"
check "supervisor exit code" "0" "$?"
check "logged the stop" "yes" \
  "$(grep -q 'stop requested\|stopped by signal' "$SCRATCH/home/logs/supervisor.log" 2>/dev/null && echo yes || echo no)"

echo "11. rename migration (a legacy dsh-autostart install -> dsh-ian-daemon)"
if command -v node >/dev/null 2>&1; then
  if node "$PLUGIN_DIR/tests/migration.mjs" >"$SCRATCH/migration.log" 2>&1; then
    check "migration test" "passed" "passed"
  else
    check "migration test" "passed" "failed (see $SCRATCH/migration.log)"
  fi
else
  echo "  skip (node not on PATH)"
fi

if [ "$FAILED" = "0" ]; then
  echo "all supervisor ladder tests passed"
  rm -rf "$SCRATCH"
else
  echo "some supervisor ladder tests failed (scratch kept in $SCRATCH)"
fi
exit "$FAILED"
