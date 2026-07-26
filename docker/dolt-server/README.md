# dolt-server — the local read-plane image

A `dolt sql-server` serving a clone of the **public** `bounded-systems/front-desk-mirror`
over the MySQL wire protocol. The scheduler's `server` reads adapter
(`src/dolt-server.ts`, `FDS_READS=server`) connects to it — the hot-path,
containerized read source (full SQL, no 1000-row cap, one persistent connection).

## Run

```sh
docker build -t front-desk-dolt-server docker/dolt-server
docker run -p 3307:3306 -e FDS_READER_PASSWORD=<pw> front-desk-dolt-server

# then, against it:
DOLT_HOST=127.0.0.1 DOLT_PORT=3307 DOLT_USER=fds_reader DOLT_PASSWORD=<pw> \
  FDS_READS=server node scripts/fds.ts whats-next
```

## Freshness

The server runs as a **dolt read replica** of DoltHub (`dolt_read_replica_remote=origin`,
`dolt_replicate_heads=main`, set as persisted system vars in the entrypoint). It
**auto-pulls `main` on every transaction** — reads are always current, with no pull
loop and no external client. Verified: a commit pushed to DoltHub appears on the
server on the next query.

## Auth

MySQL-style. The image creates a least-privilege read-only user (`fds_reader`,
`GRANT SELECT` only); its password is injected at run time (`FDS_READER_PASSWORD`).
The mirror clone/pull needs **no** credential — the DoltHub database is public.

## Destined for a guest-room

This image is a **guest**: capability-isolated, no ambient authority. Its read-only
DB credential arrives through a **door** (env today; brokered over OIDC like the
DoltHub push cred later). Reads carry no GitHub credential and cost zero rate-limit
budget — the only thing that touches GitHub is the budget-gated syncer that feeds
DoltHub, which this image mirrors from.
