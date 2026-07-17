#!/usr/bin/env bash
# Provision + deploy the sample database on a small always-on Fly Machine, then
# print the DSN and the exact `fly secrets set` commands to wire it into both
# regional web apps. The DB self-seeds on first boot (see Dockerfile), so on a
# fresh volume this is genuinely one command.
#
# Usage:
#   ./deploy.sh                      # PRIVATE (default): reachable only over 6PN/.internal
#   SAMPLE_DB_PUBLIC=1 ./deploy.sh   # PUBLIC: allocate a dedicated IPv4 (~$2/mo); DSN dial-able anywhere
#
# Posture tradeoff (see README.md "Hosting"): private is the stronger default —
# only the web/engine apps in the org can reach the DB, and the rendered DSN is
# not dial-able from a stranger's laptop. Public matches the "treat the DSN as
# public" framing exactly and lets anyone run the copy-paste Test connection.
#
# Re-runs are safe. Passwords: pass SAMPLE_PASSWORD=/POSTGRES_PASSWORD= to pin
# them; otherwise fresh random ones are generated and printed — SAVE THEM. On a
# re-deploy against an existing volume, provision/seed do NOT re-run, so a newly
# generated SAMPLE_PASSWORD would not match the role — the script warns and tells
# you how to rotate.
#
# Prereqs: flyctl installed + logged in to the Midplane org. Run from this dir.
set -euo pipefail

APP="${SAMPLE_DB_APP:-midplane-sample-db}"
REGION="${SAMPLE_DB_REGION:-fra}"
VOLUME="${SAMPLE_DB_VOLUME:-sample_pgdata}"
VOLUME_SIZE="${SAMPLE_DB_VOLUME_SIZE:-1}"
PUBLIC="${SAMPLE_DB_PUBLIC:-0}"
WEB_APPS=("midplane-web-eu" "midplane-web-us")

cd "$(dirname "$0")"

command -v fly >/dev/null 2>&1 || { echo "flyctl not found — https://fly.io/docs/flyctl/install/" >&2; exit 1; }

# --- passwords ---------------------------------------------------------------
# Superuser pw stays private; the sample-role pw ends up in the (public-by-
# design) DSN. Track whether the operator pinned each pw, to warn on reuse —
# on an existing volume NEITHER provision.sql (sample role) NOR initdb
# (superuser) re-runs, so freshly generated values silently diverge from the
# cluster's real credentials.
SAMPLE_PASSWORD_PINNED=0
[ -n "${SAMPLE_PASSWORD:-}" ] && SAMPLE_PASSWORD_PINNED=1
POSTGRES_PASSWORD_PINNED=0
[ -n "${POSTGRES_PASSWORD:-}" ] && POSTGRES_PASSWORD_PINNED=1
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(openssl rand -hex 24)}"
SAMPLE_PASSWORD="${SAMPLE_PASSWORD:-$(openssl rand -hex 24)}"

# The sample password is interpolated raw into a postgres:// URL below — a
# pinned value with URL-reserved characters (@ : / ? # etc.) would emit a
# malformed DSN that the web apps then dutifully fail on. Reject instead of
# percent-encoding: the encoded and raw forms would have to diverge between
# the DSN and provision.sql, which is exactly the drift this script avoids.
case "$SAMPLE_PASSWORD" in
  *[!A-Za-z0-9._~-]*)
    echo "SAMPLE_PASSWORD contains URL-reserved characters — use only A-Za-z0-9._~- so the DSN stays a valid URL." >&2
    exit 1 ;;
esac

# --- app ---------------------------------------------------------------------
fly apps create "$APP" ${SAMPLE_DB_ORG:+--org "$SAMPLE_DB_ORG"} 2>/dev/null || true

# --- secrets (staged; no machine yet to deploy to) ---------------------------
fly secrets set --app "$APP" --stage \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  SAMPLE_PASSWORD="$SAMPLE_PASSWORD" >/dev/null

# --- volume ------------------------------------------------------------------
VOLUME_EXISTS=0
if fly volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  VOLUME_EXISTS=1
else
  fly volumes create "$VOLUME" --app "$APP" --region "$REGION" --size "$VOLUME_SIZE" --yes >/dev/null
fi

if [ "$VOLUME_EXISTS" = 1 ] && [ "$SAMPLE_PASSWORD_PINNED" = 0 ]; then
  cat >&2 <<EOF

WARNING: volume '$VOLUME' already exists, so provision.sql/seed.sql will NOT
re-run and the midplane_sample role keeps its original password. The DSN printed
below uses a freshly generated password that will NOT match. Either:
  - re-run with the SAVED value:  SAMPLE_PASSWORD=<saved> ./deploy.sh
  - or rotate to the new one:
      fly ssh console -a $APP -C "psql -U postgres -d sample -c \"ALTER ROLE midplane_sample PASSWORD '$SAMPLE_PASSWORD'\""
EOF
fi

if [ "$VOLUME_EXISTS" = 1 ] && [ "$POSTGRES_PASSWORD_PINNED" = 0 ]; then
  cat >&2 <<EOF

WARNING: volume '$VOLUME' already exists, so initdb will NOT re-run and the
cluster keeps its ORIGINAL postgres superuser password. The POSTGRES_PASSWORD
printed below is freshly generated and does NOT apply (and the staged Fly
secret now diverges from the real one). Re-run with POSTGRES_PASSWORD=<saved>
to keep them aligned; without the saved value, recover via the local-trust
socket:  fly ssh console -a $APP -C "psql -U postgres -c \"ALTER ROLE postgres PASSWORD '<new>'\""
EOF
fi

# --- deploy (single machine; --ha=false suppresses the standby) --------------
fly deploy --app "$APP" --ha=false

# --- IP posture --------------------------------------------------------------
if [ "$PUBLIC" = "1" ]; then
  fly ips allocate-v4 --app "$APP" --yes 2>/dev/null || true   # dedicated (~$2/mo); v6 stays (free)
  HOST="${APP}.fly.dev"
  POSTURE="PUBLIC (dedicated IPv4)"
else
  # Release any public IPs so the DB is reachable only over 6PN. .internal does
  # not use allocated IPs, so releasing them does not affect app-to-app traffic.
  fly ips list --app "$APP" 2>/dev/null | awk 'NR>1 && $2 ~ /[.:]/ {print $2}' \
    | while read -r addr; do fly ips release "$addr" --app "$APP" 2>/dev/null || true; done
  # VERIFY, don't assert: a flyctl table-format change or a failed release
  # above would otherwise leave the DB internet-dialable while this script
  # prints "PRIVATE". Hard-fail so the operator never wires a DSN believing
  # a posture that isn't real.
  REMAINING=$(fly ips list --app "$APP" 2>/dev/null | awk 'NR>1 && $2 ~ /[.:]/' | wc -l | tr -d ' ')
  if [ "$REMAINING" != "0" ]; then
    echo "ERROR: private posture requested but $REMAINING public IP(s) remain on $APP." >&2
    echo "Release them manually (fly ips list -a $APP; fly ips release <addr> -a $APP) and re-run." >&2
    exit 1
  fi
  HOST="${APP}.internal"
  POSTURE="PRIVATE (6PN/.internal only)"
fi

DSN="postgres://midplane_sample:${SAMPLE_PASSWORD}@${HOST}:5432/sample?sslmode=require"

# --- sanity: row count via the local socket (works in either posture) --------
echo
echo "Sanity check (via fly ssh):"
fly ssh console --app "$APP" -C "psql -U postgres -d sample -tAc 'select count(*) from customers'" 2>/dev/null \
  | tr -d '[:space:]' | sed 's/^/  customers rows: /' || echo "  (skipped — check manually)"
echo

# --- output ------------------------------------------------------------------
cat <<EOF

Sample DB deployed.
  app:     $APP  (region $REGION, always-on, single machine)
  posture: $POSTURE

DSN (MIDPLANE_SAMPLE_DSN):
  $DSN

Wire it into both web apps (this is what makes the "Try with our sample database"
link appear — review the posture above first):
  fly secrets set --app ${WEB_APPS[0]} MIDPLANE_SAMPLE_DSN='$DSN'
  fly secrets set --app ${WEB_APPS[1]} MIDPLANE_SAMPLE_DSN='$DSN'

Superuser password (store somewhere safe; it is NOT in the DSN):
  POSTGRES_PASSWORD=$POSTGRES_PASSWORD
EOF
