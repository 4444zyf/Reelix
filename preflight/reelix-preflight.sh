#!/usr/bin/env bash
# Reelix pre-flight check (design §10.1). Run once on the NAS itself over SSH, before installing:
#
#   sudo bash reelix-preflight.sh [--downloads /volume1/data/torrents] [--library /volume1/data/library]
#
# It changes nothing except creating and immediately removing one test hard link.
# It needs nothing installed beyond a shell and (optionally) docker.

set -u
DOWNLOADS=""
LIBRARY=""
QB_NAME=""
while [ $# -gt 0 ]; do
	case "$1" in
		--downloads) DOWNLOADS="$2"; shift 2 ;;
		--library) LIBRARY="$2"; shift 2 ;;
		--qbittorrent) QB_NAME="$2"; shift 2 ;;
		-h|--help) sed -n '2,8p' "$0"; exit 0 ;;
		*) echo "unknown option $1"; exit 2 ;;
	esac
done

say() { printf '%s\n' "$*"; }
hr() { say ""; say "== $* =="; }
OK=(); BAD=(); NOTES=()
ok() { OK+=("$*"); say "  OK   $*"; }
bad() { BAD+=("$*"); say "  FAIL $*"; }
note() { NOTES+=("$*"); say "  --   $*"; }

# ---------------------------------------------------------------- 1. the machine
hr "Machine"
ARCH=$(uname -m)
NAS="Linux"
if [ -f /etc.defaults/VERSION ]; then
	. /etc.defaults/VERSION 2>/dev/null
	NAS="Synology DSM ${productversion:-${majorversion:-?}.${minorversion:-?}}"
	[ -f /etc/synoinfo.conf ] && MODEL=$(grep -m1 '^upnpmodelname=' /etc/synoinfo.conf | cut -d'"' -f2) && NAS="$NAS ($MODEL)"
elif [ -f /etc/unraid-version ]; then
	NAS="Unraid $(cut -d'"' -f2 /etc/unraid-version)"
elif [ -f /etc/config/uLinux.conf ]; then
	NAS="QNAP $(grep -m1 '^Version' /etc/config/uLinux.conf | cut -d= -f2 | tr -d ' ')"
elif [ -f /etc/os-release ]; then
	NAS=$(. /etc/os-release; echo "$PRETTY_NAME")
fi
CPU=$(grep -m1 -E 'model name|Hardware|Processor' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')
MEM=$(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo 2>/dev/null)
say "  $NAS, $ARCH, ${CPU:-unknown CPU}, $MEM RAM"
case "$ARCH" in
	x86_64|amd64) ok "x86-64: the standard Reelix image runs here" ;;
	aarch64|arm64) note "ARM64: Reelix needs an arm64 image (Node, Chromium and ffmpeg all exist for arm64)" ;;
	*) bad "CPU architecture $ARCH is not supported (Chromium has no build for it)" ;;
esac

# The NAS's home network (for magpie's allow list: the owner's browser opens magpie's page from it).
LAN_CIDR=""
if command -v ip >/dev/null 2>&1; then
	dev=$(ip -4 route show default 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
	cidr=$(ip -o -4 addr show dev "${dev:-none}" 2>/dev/null | awk '{print $4; exit}')
	if [ -n "$cidr" ]; then
		IFS=./ read -r a b c d bits <<< "$cidr"
		n=$(( (a<<24 | b<<16 | c<<8 | d) & (bits == 0 ? 0 : (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF) ))
		LAN_CIDR="$(( n>>24 & 255 )).$(( n>>16 & 255 )).$(( n>>8 & 255 )).$(( n & 255 ))/$bits"
		case "$a.$b" in
			10.*|192.168|172.1[6-9]|172.2[0-9]|172.3[01]|100.6[4-9]|100.[7-9][0-9]|100.1[01][0-9]|100.12[0-7]) say "  home network: $LAN_CIDR (via $dev)" ;;
			*) note "the NAS's network $LAN_CIDR is public, not a home network: magpie's page stays on the NAS itself"
			   LAN_CIDR=""; PUBLIC_NET=1 ;;
		esac
	fi
fi

# ---------------------------------------------------------------- 2. containers
hr "Containers"
DOCKER=""
for d in docker /usr/local/bin/docker /var/packages/ContainerManager/target/usr/bin/docker /var/packages/Docker/target/usr/bin/docker; do
	if command -v "$d" >/dev/null 2>&1; then DOCKER="$d"; break; fi
done
QB_MOUNTS=""; QB_UID=""; QB_GID=""; JF_UID=""; JF_GID=""; JF_MOUNTS=""; QB_CONFIG_HOST=""
QB_URL=""; JK_URL=""; JF_URL=""; JOIN_NETWORK=""; QB_FOUND=""; JK_FOUND=""; JF_FOUND=""
# How Reelix's container reaches a found container (docs/deployment.md, "Reaching each other"):
#   a user network -> join it, use the container name; behind a VPN container -> that container's name;
#   host networking -> host.docker.internal; Docker's default bridge (no names) -> the published port on the NAS.
reach() {   # sets REACH (the address) and may set JOIN_NETWORK; no subshell, so both survive
	local c="$1" port="$2" mode nets net pub via
	REACH=""
	mode=$(inspect "$c" '{{.HostConfig.NetworkMode}}')
	case "$mode" in
		host) REACH="http://host.docker.internal:$port"; return ;;
		container:*)
			via=$(inspect "${mode#container:}" '{{.Name}}' | sed 's#^/##'); [ -z "$via" ] && via=${mode#container:}
			c="$via" ;;
	esac
	nets=$(inspect "$c" '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}')
	net=$(say "$nets" | tr ' ' '\n' | grep -v -E '^(bridge|host|none)?$' | head -1)
	if [ -n "$net" ]; then
		[ -z "$JOIN_NETWORK" ] && JOIN_NETWORK="$net"
		REACH="http://$c:$port"; return
	fi
	pub=$(inspect "$c" "{{(index (index .NetworkSettings.Ports \"$port/tcp\") 0).HostPort}}")
	REACH="http://host.docker.internal:${pub:-$port}"
}
inspect() { "$DOCKER" inspect --format "$2" "$1" 2>/dev/null; }
env_of() { inspect "$1" '{{range .Config.Env}}{{println .}}{{end}}' | grep -E "^$2=" | head -1 | cut -d= -f2; }
if [ -z "$DOCKER" ]; then
	note "docker not found; skipping container discovery (pass --downloads and --library)"
elif ! "$DOCKER" ps >/dev/null 2>&1; then
	note "cannot talk to docker (run with sudo); skipping container discovery"
else
	NAMES=$("$DOCKER" ps --format '{{.Names}} {{.Image}}')
	say "$NAMES" | sed 's/^/  running: /'
	find_c() { say "$NAMES" | grep -i -E "$1" | head -1 | cut -d' ' -f1; }
	QB=${QB_NAME:-$(find_c 'qbittorrent')}
	JK=$(find_c 'jackett')
	JF=$(find_c 'jellyfin')
	for pair in "qBittorrent:$QB" "Jackett:$JK" "Jellyfin:$JF"; do
		label=${pair%%:*}; c=${pair#*:}
		if [ -z "$c" ]; then note "$label: no running container found"; continue; fi
		uid=$(env_of "$c" PUID); gid=$(env_of "$c" PGID)
		user=$(inspect "$c" '{{.Config.User}}')
		[ -z "$uid" ] && [ -n "$user" ] && uid=${user%%:*} && gid=${user#*:}
		mounts=$(inspect "$c" '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{println}}{{end}}' | sed '/^$/d')
		say "  $label ($c): runs as uid=${uid:-root?} gid=${gid:-?}"
		say "$mounts" | sed 's/^/      mount: /'
		case "$label" in
			qBittorrent) QB_MOUNTS="$mounts"; QB_UID="$uid"; QB_GID="$gid"; QB_FOUND="$c"
				QB_CONFIG_HOST=$(say "$mounts" | awk -F' -> ' '$2=="/config" {print $1}')
				reach "$c" "$(env_of "$c" WEBUI_PORT | grep . || echo 8080)"; QB_URL=$REACH ;;
			Jackett) JK_FOUND="$c"; reach "$c" 9117; JK_URL=$REACH ;;
			Jellyfin) JF_MOUNTS="$mounts"; JF_UID="$uid"; JF_GID="$gid"; JF_FOUND="$c"; reach "$c" 8096; JF_URL=$REACH ;;
		esac
		say "      Reelix will reach it at: $REACH"
	done
fi

# Map a container path to the host using a mount list ("host -> container" lines). Longest match wins.
to_host() {
	local p="$1" mounts="$2" best="" bestlen=0 src dst
	while IFS= read -r line; do
		[ -z "$line" ] && continue
		src=${line%% -> *}; dst=${line#* -> }
		case "$p" in "$dst"|"$dst"/*) if [ ${#dst} -gt $bestlen ]; then best="$src${p#$dst}"; bestlen=${#dst}; fi ;; esac
	done <<< "$mounts"
	say "${best:-$p}"
}

# ---------------------------------------------------------------- 3. where qBittorrent saves
hr "Downloads"
QB_SAVE=""
if [ -n "$QB_CONFIG_HOST" ]; then
	CONF=$(find "$QB_CONFIG_HOST" -maxdepth 3 -name qBittorrent.conf 2>/dev/null | head -1)
	if [ -n "$CONF" ]; then
		QB_SAVE=$(grep -m1 -E '^Session\\DefaultSavePath=|^Downloads\\SavePath=' "$CONF" | cut -d= -f2-)
		TEMP=$(grep -m1 -E '^Session\\TempPath=' "$CONF" | cut -d= -f2-)
		TEMP_ON=$(grep -m1 -E '^Session\\TempPathEnabled=' "$CONF" | cut -d= -f2-)
		say "  qBittorrent saves to (inside its container): ${QB_SAVE:-default}"
		[ "$TEMP_ON" = "true" ] && note "incomplete downloads go to $TEMP and move on completion (Reelix reads locations at completion, so this is fine)"
	fi
fi
if [ -z "$DOWNLOADS" ] && [ -n "$QB_SAVE" ]; then DOWNLOADS=$(to_host "$QB_SAVE" "$QB_MOUNTS"); fi
if [ -z "$DOWNLOADS" ]; then
	bad "could not find the download folder; pass --downloads /path/on/the/nas"
else
	say "  download folder on the NAS: $DOWNLOADS"
	[ -d "$DOWNLOADS" ] || bad "$DOWNLOADS does not exist"
fi
if [ -z "$LIBRARY" ] && [ -n "$JF_MOUNTS" ]; then
	# guess: the Jellyfin mount that is not config/cache
	LIBRARY=$(say "$JF_MOUNTS" | grep -v -E -- '-> /(config|cache|transcode)' | head -1 | sed 's/ -> .*//')
	[ -n "$LIBRARY" ] && note "library guessed from Jellyfin's mounts: $LIBRARY"
fi
if [ -z "$LIBRARY" ] && [ -n "$DOWNLOADS" ]; then
	LIBRARY="$(dirname "$DOWNLOADS")/library"
	note "no library given; proposing $LIBRARY (next to the downloads)"
fi
say "  proposed library: $LIBRARY"

# ---------------------------------------------------------------- 4. the real hard-link test
hr "Hard links"
MEDIA_ROOT=""
common_parent() {
	local a="$1" b="$2"
	while [ -n "$a" ] && [ "$a" != "/" ]; do
		case "$b/" in "$a"/*) say "$a"; return ;; esac
		a=$(dirname "$a")
	done
	say "/"
}
if [ -n "$DOWNLOADS" ] && [ -d "$DOWNLOADS" ]; then
	SAMPLE=$(find "$DOWNLOADS" -type f -size +1k ! -path '*@eaDir*' ! -name '*.!qB' 2>/dev/null | head -1)
	if [ -z "$SAMPLE" ]; then
		bad "no file in $DOWNLOADS to test with; download something small with qBittorrent first"
	else
		say "  test file (written by qBittorrent): $SAMPLE"
		say "  owner: $(stat -c 'uid=%u gid=%g mode=%a' "$SAMPLE" 2>/dev/null)"
		TESTDIR="$LIBRARY"
		CREATED=""
		if [ ! -d "$TESTDIR" ]; then mkdir -p "$TESTDIR" 2>/dev/null && CREATED=1; fi
		TARGET="$TESTDIR/.reelix-preflight-$$"
		if ln "$SAMPLE" "$TARGET" 2>/tmp/reelix-ln-err.$$; then
			INO1=$(stat -c %i "$SAMPLE"); INO2=$(stat -c %i "$TARGET")
			rm -f "$TARGET"
			if [ "$INO1" = "$INO2" ]; then ok "a hard link from the downloads into $LIBRARY works"; else bad "link made but inode differs"; fi
			LINK_OK=1
		else
			ERR=$(cat /tmp/reelix-ln-err.$$)
			bad "hard link failed: $ERR"
			case "$ERR" in
				*"cross-device"*|*"Invalid cross-device"*) say "      The download folder and the library are on different filesystems, mounts or (on Synology) different shared folders.";;
			esac
			LINK_OK=0
		fi
		rm -f /tmp/reelix-ln-err.$$
		[ -n "$CREATED" ] && rmdir "$TESTDIR" 2>/dev/null
		# As qBittorrent's user: Linux refuses links to files the user neither owns nor can write.
		if [ -n "$QB_UID" ] && command -v setpriv >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && [ "${LINK_OK:-0}" = 1 ]; then
			mkdir -p "$TESTDIR" 2>/dev/null
			if setpriv --reuid "$QB_UID" --regid "${QB_GID:-$QB_UID}" --clear-groups ln "$SAMPLE" "$TARGET" 2>/dev/null; then
				rm -f "$TARGET"; ok "the link also works as qBittorrent's user (uid $QB_UID)"
			else
				bad "as qBittorrent's user (uid $QB_UID) the link fails: the library folder must be writable by that user"
			fi
			[ -n "$CREATED" ] && rmdir "$TESTDIR" 2>/dev/null
		fi
		# Can Jellyfin read files as qBittorrent wrote them?
		if [ -n "$JF_UID" ]; then
			MODE=$(stat -c %a "$SAMPLE"); FUID=$(stat -c %u "$SAMPLE"); FGID=$(stat -c %g "$SAMPLE")
			o=${MODE: -1}; g=${MODE: -2:1}
			if [ "$JF_UID" = "$FUID" ] || { [ "$JF_GID" = "$FGID" ] && [ $((g & 4)) -ne 0 ]; } || [ $((o & 4)) -ne 0 ]; then
				ok "Jellyfin (uid $JF_UID) can read files as qBittorrent writes them"
			else
				bad "Jellyfin (uid $JF_UID gid $JF_GID) cannot read files owned by $FUID:$FGID mode $MODE; set qBittorrent's umask to 002 or run both with one group"
			fi
		fi
	fi
	MEDIA_ROOT=$(common_parent "$DOWNLOADS" "$LIBRARY")
	# Synology: /volumeN/<share>/… — two shares can never be linked.
	case "$DOWNLOADS" in
		/volume*/*)
			s1=$(say "$DOWNLOADS" | cut -d/ -f2,3); s2=$(say "$LIBRARY" | cut -d/ -f2,3)
			if [ "$s1" != "$s2" ]; then bad "downloads ($s1) and library ($s2) are different Synology shared folders; hard links between shared folders are impossible"; fi ;;
	esac
fi

# ---------------------------------------------------------------- 5. recommendation
hr "Recommendation"
if [ ${#BAD[@]} -eq 0 ] && [ -n "$MEDIA_ROOT" ] && [ "$MEDIA_ROOT" != "/" ]; then
	DL_REL=${DOWNLOADS#$MEDIA_ROOT}; LIB_REL=${LIBRARY#$MEDIA_ROOT}
	say "This layout works. Put this in .env next to docker-compose.yml (from .env.example):"
	say ""
	PROFILES=""
	[ -z "$QB_FOUND" ] && PROFILES="$PROFILES,qbittorrent"
	[ -z "$JK_FOUND" ] && PROFILES="$PROFILES,jackett"
	[ -z "$JF_FOUND" ] && PROFILES="$PROFILES,jellyfin"
	say "  COMPOSE_PROFILES=${PROFILES#,}        # add ,magpie for the model gateway"
	say "  MEDIA_ROOT=$MEDIA_ROOT"
	say "  PUID=${QB_UID:-1000}"
	say "  PGID=${QB_GID:-1000}"
	say "  QBITTORRENT_URL=${QB_URL:-http://qbittorrent:8080}"
	say "  JACKETT_URL=${JK_URL:-http://jackett:9117}"
	say "  JELLYFIN_URL=${JF_URL:-http://jellyfin:8096}"
	say "  MAGPIE_URL=http://magpie:3425"
	if [ -n "${PUBLIC_NET:-}" ]; then
		say "  MAGPIE_ALLOW_IPS_EXTRA=             # public network: nobody else"
		say "  MAGPIE_WEB_BIND=127.0.0.1           # open magpie's page through an SSH tunnel: ssh -L 3430:127.0.0.1:3430 <nas>"
	else
		say "  MAGPIE_ALLOW_IPS_EXTRA=${LAN_CIDR}     # your home network may open magpie's page"
	fi
	say ""
	if [ -n "$JOIN_NETWORK" ]; then
		say "  Reelix joins the network of your existing containers so it can call them by name."
		say "  Copy docker-compose.override.example.yml to docker-compose.override.yml with:"
		say "    name: $JOIN_NETWORK"
		say ""
	fi
	say "  In Reelix: downloads = /media$DL_REL, library = /media$LIB_REL/{Movies,Shows,Anime}"
	QB_MEDIA_DST=$(say "$QB_MOUNTS" | awk -F' -> ' -v r="$MEDIA_ROOT" '$1==r {print $2}' | head -1)
	if [ -n "$QB_FOUND" ] && [ "${QB_MEDIA_DST:-/media}" != "/media" ]; then
		say "  qBittorrent sees this folder as ${QB_MEDIA_DST:-?}, not /media; tell Reelix once it runs:"
		say "    reelix config set path_maps.downloaders.qbittorrent '[{\"theirs\":\"${QB_MEDIA_DST:-?}\",\"ours\":\"/media\"}]'"
	elif [ -n "$QB_FOUND" ] && [ -z "$QB_MEDIA_DST" ]; then
		say "  qBittorrent's save path ${QB_SAVE:-?} = /media$DL_REL in Reelix (set path_maps.downloaders.qbittorrent if they differ)"
	fi
	JF_MEDIA_DST=$(say "$JF_MOUNTS" | awk -F' -> ' -v r="$MEDIA_ROOT" '$1==r {print $2}' | head -1)
	if [ -n "$JF_FOUND" ] && [ -n "$JF_MEDIA_DST" ] && [ "$JF_MEDIA_DST" != "/media" ]; then
		say "  Jellyfin sees this folder as $JF_MEDIA_DST; tell Reelix once it runs:"
		say "    reelix config set path_maps.media_servers.jellyfin '[{\"theirs\":\"$JF_MEDIA_DST\",\"ours\":\"/media\"}]'"
	fi
else
	say "The layout needs a change before Reelix can hard-link:"
	for b in "${BAD[@]}"; do say "  - $b"; done
	say ""
	say "Two ways to fix it:"
	say "  1. Put downloads and library under ONE shared folder (e.g. /volume1/data/torrents and /volume1/data/library)."
	say "     Move the library folder there (a move within a share is instant; across shares it copies),"
	say "     re-point Jellyfin's libraries, and mount /volume1/data into qBittorrent as well, keeping its save path."
	say "  2. Keep the library where it is and move the download folder into the library's shared folder;"
	say "     qBittorrent must then be told the new save path (existing torrents: 'Set location', which moves their data)."
	say "Option 1 is usually cheaper: the library is links, downloads are the data."
fi
say ""
say "Nothing was changed except one test link, created and removed."
say "REELIX_PREFLIGHT nas=\"$NAS\" arch=$ARCH downloads=\"$DOWNLOADS\" library=\"$LIBRARY\" media_root=\"$MEDIA_ROOT\" qb_uid=${QB_UID:-} qb_gid=${QB_GID:-} jf_uid=${JF_UID:-} qb_url=\"${QB_URL:-}\" jackett_url=\"${JK_URL:-}\" jellyfin_url=\"${JF_URL:-}\" join_network=\"${JOIN_NETWORK:-}\" lan=\"${LAN_CIDR:-}\" failures=${#BAD[@]}"
