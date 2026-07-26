#!/usr/bin/env bash
# Clone (or refresh) the public mirror, create a read-only user, serve it.
# No credential is needed to clone — the DoltHub mirror is public.
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/dolt}"
DB="$(basename "$MIRROR")"        # front-desk-mirror
cd "$DATA_DIR"

if [ ! -d "$DB/.dolt" ]; then
  echo "cloning $MIRROR ..."
  dolt clone "$MIRROR" "$DB"
else
  echo "refreshing $DB ..."
  ( cd "$DB" && dolt pull || true )
fi

# Create the least-privilege read-only user (idempotent). Password from the door.
: "${FDS_READER_PASSWORD:?set FDS_READER_PASSWORD (injected by the guest-room door)}"
cd "$DB"
dolt sql -q "CREATE USER IF NOT EXISTS '${FDS_READER_USER}'@'%' IDENTIFIED BY '${FDS_READER_PASSWORD}';
             GRANT SELECT ON \`${DB}\`.* TO '${FDS_READER_USER}'@'%';"

echo "serving $DB on :3306 (read-only user ${FDS_READER_USER})"
exec dolt sql-server --host 0.0.0.0 --port 3306
