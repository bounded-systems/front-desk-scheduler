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

# Freshness: run as a READ REPLICA of DoltHub. Persisted system vars make the
# server auto-pull `main` from the `origin` remote on each transaction, so reads
# are always current — native, no pull loop, no external client. Public mirror →
# no credential needed for replication.
dolt sql -q "SET @@PERSIST.dolt_read_replica_remote = 'origin';
             SET @@PERSIST.dolt_replicate_heads = 'main';"

echo "serving $DB on :3306 (read-only ${FDS_READER_USER}, read-replica of ${MIRROR})"
exec dolt sql-server --host 0.0.0.0 --port 3306
