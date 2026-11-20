#!/bin/sh
# Reelix's container starts as root only to get here (docs/deployment.md "Users and files"). This script:
#   1. gives the data folder to Reelix's user (PUID) and its own group `reelix`, once, and again whenever something
#      else owns part of it (a changed PUID, a `docker exec` as root);
#   2. starts the command as PUID:PGID with its umask 002, its groups `reelix`, `reelix-agent` and
#      `reelix-plugin`, and only the capabilities to start the agent's shell and plugins' processes as those
#      users and to signal them (setuid, setgid, kill), never more (bounding set, no_new_privs).
# Reelix itself (packages/server/src/isolation.ts) closes the data folder to the two other users before anything
# runs as them. Run with arguments, it starts those instead of the server, with the same rights.
set -eu

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA="${REELIX_DATA:-/data}"

fail() {
	echo "reelix: $*" >&2
	exit 1
}

[ "$(id -u)" = 0 ] || fail "the image starts as root and switches to PUID:PGID itself; remove 'user:' (or --user) and set PUID and PGID instead."
AGENT="$(id -u reelix-agent)"
PLUGIN="$(id -u reelix-plugin)"
GROUP="$(getent group reelix | cut -d: -f3)"
case "$PUID$PGID" in *[!0-9]*) fail "PUID and PGID must be numbers." ;; esac
[ "$PUID" != 0 ] && [ "$PGID" != 0 ] || fail "PUID and PGID may not be 0: Reelix does not run as root."
for id in "$AGENT" "$PLUGIN" "$GROUP"; do
	[ "$PUID" != "$id" ] && [ "$PGID" != "$id" ] || fail "PUID or PGID $id is one of the image's own users (reelix, reelix-agent, reelix-plugin); choose another."
done

mkdir -p "$DATA"
find "$DATA" -xdev ! -user "$PUID" ! -user "$AGENT" ! -user "$PLUGIN" -exec chown -h "$PUID" {} +
find "$DATA" -xdev ! -group "$GROUP" ! -group "$AGENT" ! -group "$PLUGIN" -exec chgrp -h "$GROUP" {} +
find "$DATA" -xdev -type d ! -perm -2000 -exec chmod g+s {} +

umask 002
export REELIX_AGENT_ID="$AGENT" REELIX_PLUGIN_ID="$PLUGIN"
exec setpriv --reuid="$PUID" --regid="$PGID" --groups="$GROUP,$AGENT,$PLUGIN" \
	--inh-caps=-all,+setuid,+setgid,+kill --ambient-caps=-all,+setuid,+setgid,+kill \
	--bounding-set=-all,+setuid,+setgid,+kill --no-new-privs -- "$@"
