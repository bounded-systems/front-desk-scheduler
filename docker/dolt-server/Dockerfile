# The "dolt image" — a local read-plane server: a dolt sql-server serving a clone
# of the PUBLIC front-desk-mirror over the MySQL wire protocol. The scheduler's
# `server` reads adapter (src/dolt-server.ts) connects to it; it's the hot-path /
# containerized alternative to the DoltHub HTTP plane and the local-file adapter.
#
# Destined for a guest-room (capability-isolated): this image is the GUEST; its
# read-only MySQL credential is provided through a DOOR (env today, brokered like
# the DoltHub cred later) — no ambient authority. The mirror is public, so the
# clone/pull needs no credential at all.
FROM dolthub/dolt-sql-server:latest

ENV MIRROR=bounded-systems/front-desk-mirror
# The read-only user the scheduler connects as (password injected at run time).
ENV FDS_READER_USER=fds_reader

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 3306
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
