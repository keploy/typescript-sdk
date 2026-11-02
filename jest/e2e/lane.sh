#!/usr/bin/env bash
# The e2e lane of @keploy/jest: this commit's package, packed and installed
# into a small Jest suite (e2e/shop), run under a real keploy that judges each
# test. The suite's code calls a provider over HTTP; keploy records those
# calls with the provider up, and replays them with the provider stopped.
#
#   KEPLOY_BIN=/path/to/keploy bash jest/e2e/lane.sh
#
# KEPLOY_BIN is a keploy build that judges each test under KEPLOY_PROVEN=1
# (keploy's enterprise build; the CI job downloads a pinned release). keploy
# needs root for its eBPF hooks: the lane runs it through sudo unless it is
# root already. Node.js 20 or later and npm must be on PATH.
#
# Checks, each judged by what a user reads (exit codes, Jest's summary and
# each test's failure text, the files keploy wrote):
#   1. without keploy the suite passes as plain Jest, and nothing says keploy;
#   2. keploy mock record keeps each test's calls under the test's name;
#   3. keploy mock replay, with the provider stopped, passes every test;
#   4. a test whose call has no recorded answer fails, by keploy, with
#      keploy's text in Jest's failure of that test; the others pass;
#   5. a test that no longer makes its recorded call fails, by keploy, at its
#      end; the others pass;
#   6. a test quarantined in the set is skipped by Jest, with keploy's reason
#      printed, and the replay passes.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
KEPLOY_BIN="${KEPLOY_BIN:?set KEPLOY_BIN to a keploy binary}"
PORT="${SHOP_PORT:-18731}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/keploy-jest-e2e.XXXXXX")"
FAILED=0
PROVIDER_PID=""
export SHOP_PROVIDER="http://127.0.0.1:$PORT"

cleanup() {
  [ -z "$PROVIDER_PID" ] || kill "$PROVIDER_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

ok() { echo "  ok: $*"; }
fail() { echo "  FAIL: $*"; FAILED=1; }
# show ID: the run's output, for a failing check.
show() {
  local stream
  for stream in out err; do
    echo "  --- $1: std$stream (last 120 lines, keploy's banner left out) ---"
    grep -av '38;5;' "$WORK/logs/$1.$stream" | tail -n 120 | sed 's/^/  | /'
  done
}

if [ "$(id -u)" -eq 0 ]; then AS_ROOT=(env); else AS_ROOT=(sudo -E env "PATH=$PATH" "HOME=$HOME"); fi

# The package as npm would publish it, installed into a copy of the suite.
mkdir -p "$WORK/logs" "$WORK/pkg"
tar -C "$PKG" --exclude=./node_modules --exclude=./dist --exclude=./e2e -cf - . | tar -C "$WORK/pkg" -xf -
(cd "$WORK/pkg" && npm ci --no-audit --no-fund && npm run build && npm pack --pack-destination "$WORK") >"$WORK/logs/pack.log" 2>&1 ||
  { cat "$WORK/logs/pack.log"; echo "FAIL: could not build and pack the package"; exit 1; }
TGZ=$(ls "$WORK"/keploy-jest-*.tgz)
cp -R "$HERE/shop" "$WORK/shop"
rm -rf "$WORK/shop/node_modules"
cd "$WORK/shop" || exit 1
(npm ci --no-audit --no-fund && npm install --no-save --no-audit --no-fund "$TGZ") >"$WORK/logs/install.log" 2>&1 ||
  { cat "$WORK/logs/install.log"; echo "FAIL: could not install the suite"; exit 1; }
echo "installed $(basename "$TGZ") into the suite at $WORK/shop"

start_provider() {
  : >"$WORK/logs/provider.log"
  node provider.js "$PORT" >"$WORK/logs/provider.log" 2>&1 &
  PROVIDER_PID=$!
  until grep -qx ready "$WORK/logs/provider.log"; do
    kill -0 "$PROVIDER_PID" 2>/dev/null || { cat "$WORK/logs/provider.log"; echo "FAIL: the provider exited before it listened"; exit 1; }
    sleep 0.2
  done
}
stop_provider() {
  kill "$PROVIDER_PID" 2>/dev/null
  wait "$PROVIDER_PID" 2>/dev/null
  PROVIDER_PID=""
}

# run ID CMD...: one run, stdin closed, stdout and stderr kept apart. Sets EC.
run() {
  local id=$1
  shift
  echo
  echo "== $id: $*"
  "$@" </dev/null >"$WORK/logs/$id.out" 2>"$WORK/logs/$id.err"
  EC=$?
  echo "  exit $EC"
  # LANE_VERBOSE=1 shows every run's output, not only a failing check's.
  [ -z "${LANE_VERBOSE:-}" ] || show "$id"
}
# keploy ID ARGS...: one keploy run under the proven switch, as root.
keploy() {
  local id=$1
  shift
  run "$id" "${AS_ROOT[@]}" KEPLOY_PROVEN=1 KEPLOY_INVOKER=ci "SHOP_PROVIDER=$SHOP_PROVIDER" \
    "SHOP_CHANGE=${SHOP_CHANGE:-}" "$KEPLOY_BIN" "$@" --disable-tele
}
# failure_of ID TITLE: Jest's failure of the test TITLE in a run: the lines
# after its "● TITLE" header, up to the next header or Jest's summary.
failure_of() {
  awk -v h="● $2" '{ t = $0; sub(/^[ \t]+/, "", t) }
    t == h { on = 1; next }
    on && (t ~ /^● / || t ~ /^Test Suites:/) { on = 0 }
    on' "$WORK/logs/$1.err"
}
# keploy_lines ID: keploy's own lines of a run's end block that name a test.
keploy_lines() { grep -aE '^ *(FAILED|FAILED_BY_KEPLOY|MISS|UNCONSUMED|VERDICT|PASSED|SKIPPED)' "$WORK/logs/$1.err" | head -n 20; }
# jest_summary ID: Jest's "Tests:" line of a run.
jest_summary() { grep -a '^Tests: ' "$WORK/logs/$1.err" | tail -n 1 | tr -s ' '; }

JEST='npx jest -i'
ORDERS='__tests__/orders.test.js::orders'
PRICES="$ORDERS › prices a book"
RESERVES="$ORDERS › reserves a book"
CHARGES='__tests__/payments.test.js::charges a card'
# judge ID WHAT: reports a check from the reasons WHY holds against it.
judge() {
  if [ "${#WHY[@]}" -eq 0 ]; then ok "$2"; return; fi
  fail "$2"
  printf '    - %s\n' "${WHY[@]}"
  show "$1"
}
# has ID TEXT: whether the run's stderr (Jest's and keploy's) has a line
# that is TEXT.
has() { grep -aqxF -- "$2" "$WORK/logs/$1.err"; }

# 1. Without keploy: plain Jest.
start_provider
run inert npx jest -i
WHY=()
[ "$EC" -eq 0 ] || WHY+=("exit $EC, want 0")
[ "$(jest_summary inert)" = "Tests: 3 passed, 3 total" ] || WHY+=("Jest says '$(jest_summary inert)'")
! grep -aqi keploy "$WORK/logs/inert.out" "$WORK/logs/inert.err" || WHY+=("a line says keploy")
judge inert "without keploy the suite passes as plain Jest, and nothing says keploy"

# 2. Record, with the provider up: keploy's own rounds replay it twice more.
keploy record mock record --local -c "$JEST"
stop_provider
WHY=()
[ "$EC" -eq 0 ] || WHY+=("exit $EC, want 0")
has record "keploy: committed keploy/shop and its verdicts.yaml: 3 replayable, 0 quarantined" ||
  WHY+=("keploy did not commit 3 replayable tests")
for t in "$PRICES" "$RESERVES" "$CHARGES"; do
  grep -aqxF -- "    - id: $t" keploy/shop/mappings.yaml 2>/dev/null || WHY+=("keploy/shop/mappings.yaml does not name $t")
done
judge record "keploy mock record keeps each test's calls under its file and Jest's title"

# 3. Replay with the provider stopped.
keploy replay mock replay --local -c "$JEST"
WHY=()
[ "$EC" -eq 0 ] || WHY+=("exit $EC, want 0")
[ "$(jest_summary replay)" = "Tests: 3 passed, 3 total" ] || WHY+=("Jest says '$(jest_summary replay)'")
has replay "keploy: shop: 3 test(s) ran: 3 passed, 0 failed (0 held by keploy), 0 skipped by the test; 0 quarantined (skipped by keploy)" ||
  WHY+=("keploy did not judge 3 tests passed")
has replay "VERDICT  passed" || WHY+=("keploy's verdict is not passed")
judge replay "keploy mock replay with the provider stopped passes every test"

# 4. A call the recording has no answer for: keploy fails that test, in
# Jest's own failure of it, and only that test.
SHOP_CHANGE=miss keploy replay-miss mock replay --local -c "$JEST"
WHY=()
[ "$EC" -eq 1 ] || WHY+=("exit $EC, want 1")
[ "$(jest_summary replay-miss)" = "Tests: 1 failed, 2 passed, 3 total" ] || WHY+=("Jest says '$(jest_summary replay-miss)'")
failure_of replay-miss "orders › prices a book" | grep -aqF "KeployError: keploy: GET /price/pen to 127.0.0.1:$PORT had no recorded answer (path differs)" ||
  WHY+=("Jest's failure of prices a book does not carry keploy's miss")
has replay-miss "FAILED_BY_KEPLOY  $PRICES (failed): keploy/unmocked_call" || WHY+=("keploy does not hold the miss against prices a book")
judge replay-miss "a call with no recorded answer fails its own test with keploy's text; the others pass"

# 5. A recorded call the test no longer makes: keploy fails it at its end.
SHOP_CHANGE=unconsumed keploy replay-unconsumed mock replay --local -c "$JEST"
WHY=()
[ "$EC" -eq 1 ] || WHY+=("exit $EC, want 1")
[ "$(jest_summary replay-unconsumed)" = "Tests: 1 failed, 2 passed, 3 total" ] || WHY+=("Jest says '$(jest_summary replay-unconsumed)'")
failure_of replay-unconsumed "orders › reserves a book" | grep -aqF "KeployError: keploy: recorded call POST /reserve (mock-1) was never made." ||
  WHY+=("Jest's failure of reserves a book does not carry keploy's unmade call")
has replay-unconsumed "FAILED_BY_KEPLOY  $RESERVES (failed): keploy/unconsumed_mock" || WHY+=("keploy does not hold the unmade call against reserves a book")
judge replay-unconsumed "a recorded call the test no longer makes fails that test with keploy's text; the others pass"

# 6. A test quarantined in the set: Jest skips it, before any hook, with
# keploy's reason printed; the replay passes.
keploy quarantine mock quarantine "$CHARGES" --reason 'e2e: set aside by the lane' --local --name shop
WHY=()
[ "$EC" -eq 0 ] || WHY+=("keploy mock quarantine exited $EC")
keploy replay-quarantined mock replay --local -c "$JEST"
[ "$EC" -eq 0 ] || WHY+=("replay exit $EC, want 0")
[ "$(jest_summary replay-quarantined)" = "Tests: 1 skipped, 2 passed, 3 total" ] || WHY+=("Jest says '$(jest_summary replay-quarantined)'")
grep -aqE "^keploy: .*\[skipped __tests__/payments\.test\.js › charges a card\]$" "$WORK/logs/replay-quarantined.err" ||
  WHY+=("@keploy/jest did not print keploy's reason for skipping charges a card")
grep -aqF "1 quarantined (skipped by keploy)" "$WORK/logs/replay-quarantined.err" || WHY+=("keploy does not count 1 quarantined test")
judge replay-quarantined "a quarantined test is skipped by Jest with keploy's reason; the replay passes"

echo
if [ "$FAILED" -ne 0 ]; then echo "e2e: FAILED (logs in $WORK/logs)"; exit 1; fi
echo "e2e: every check passed"
