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

# ---------------------------------------------------------------- 2. containers
hr "Containers"
DOCKER=""
for d in docker /usr/local/bin/docker /var/packages/ContainerManager/target/usr/bin/docker /var/packages/Docker/target/usr/bin/docker; do
	if command -v "$d" >/dev/null 2>&1; then DOCKER="$d"; break; fi
done
QB_MOUNTS=""; QB_UID=""; QB_GID=""; JF_UID=""; JF_GID=""; JF_MOUNTS=""; QB_CONFIG_HOST=""
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
			qBittorrent) QB_MOUNTS="$mounts"; QB_UID="$uid"; QB_GID="$gid"
				QB_CONFIG_HOST=$(say "$mounts" | awk -F' -> ' '$2=="/config" {print $1}') ;;
			Jellyfin) JF_MOUNTS="$mounts"; JF_UID="$uid"; JF_GID="$gid" ;;
		esac
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
	say "This layout works. Mount the common parent ONCE into Reelix as /media:"
	say ""
	say "  docker run -d --name reelix --restart unless-stopped \\"
	say "    --user ${QB_UID:-1000}:${QB_GID:-1000} \\"
	say "    -p 7878:7878 \\"
	say "    -v $MEDIA_ROOT:/media \\"
	say "    -v /path/to/reelix-data:/data \\"
	say "    reelix:latest"
	say ""
	say "  Then in Reelix: downloads = /media$DL_REL, library = /media$LIB_REL/{Movies,Shows,Anime}"
	say "  qBittorrent path map: its save path ${QB_SAVE:-?} = /media$DL_REL"
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
say "REELIX_PREFLIGHT nas=\"$NAS\" arch=$ARCH downloads=\"$DOWNLOADS\" library=\"$LIBRARY\" media_root=\"$MEDIA_ROOT\" qb_uid=${QB_UID:-} qb_gid=${QB_GID:-} jf_uid=${JF_UID:-} failures=${#BAD[@]}"
