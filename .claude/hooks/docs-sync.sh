#!/usr/bin/env bash
# Claude Code PreToolUse hook (Bash): before an agent commits or pushes, it must check that the README,
# the skills, the website and the screenshots still match the code. Wired in .claude/settings.json.
#
#   (hook)  reads the tool call on stdin; lets anything but `git commit` / `git push` through.
#           A commit passes once the current working tree has been checked; a push once the tree of HEAD has.
#           Otherwise it blocks (exit 2) and tells the agent what to check.
#   ack     run by the agent after checking: records the current working tree (and HEAD) as checked.
#
# The record lives in .git/claude-docs-checked, outside the repository's files.

set -u
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0
RECORD="$(git rev-parse --git-dir)/claude-docs-checked"

# The tree the working tree would commit as with `git add -A`, without touching the real index.
worktree_tree() {
	local tmp
	tmp=$(mktemp)
	cp "$(git rev-parse --git-dir)/index" "$tmp" 2>/dev/null
	GIT_INDEX_FILE="$tmp" git add -A >/dev/null 2>&1
	GIT_INDEX_FILE="$tmp" git write-tree
	rm -f "$tmp"
}

if [ "${1:-}" = "ack" ]; then
	{ worktree_tree; git rev-parse 'HEAD^{tree}' 2>/dev/null; } >> "$RECORD"
	echo "Recorded as checked: the current working tree. Commit and push it now; any later change needs a new check."
	exit 0
fi

command=$(jq -r '.tool_input.command // empty')
case "$command" in
	*"docs-sync.sh ack"*) exit 0 ;;
esac
if printf '%s' "$command" | grep -Eq '(^|[;&|(]|[[:space:]])git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'; then
	action=commit
elif printf '%s' "$command" | grep -Eq '(^|[;&|(]|[[:space:]])git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]|$)'; then
	action=push
else
	exit 0
fi

if [ "$action" = commit ]; then
	key=$(worktree_tree)
	changed=$( { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
else
	key=$(git rev-parse 'HEAD^{tree}')
	base=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || echo origin/main)
	changed=$(git diff --name-only "$base"..HEAD 2>/dev/null)
fi
[ -z "$changed" ] && exit 0
grep -qxF "$key" "$RECORD" 2>/dev/null && exit 0

# Screenshots: what changed in the web UI (or its themes and locales) since they were last taken.
shots_commit=$(git log -1 --format=%H -- website/assets/shots)
ui_changed=""
if [ -n "$shots_commit" ]; then
	ui_changed=$( { git diff --name-only "$shots_commit" -- packages/web/src packages/web/public themes 'plugins/*/web' 'plugins/*/locales'
		git ls-files --others --exclude-standard -- packages/web/src packages/web/public themes; } | sort -u)
fi

{
	echo "Blocked: before this $action, check that the documentation still matches the code."
	echo ""
	echo "Files in this $action:"
	printf '%s\n' "$changed" | sed 's/^/  /' | head -60
	[ "$(printf '%s\n' "$changed" | wc -l)" -gt 60 ] && echo "  …"
	echo ""
	echo "Read the changes, then check each of these against the real code (fix what is wrong, say what you left):"
	echo "  1. README.md: features, installation (both the human steps and the agent prompt), usage, plugins,"
	echo "     project layout, status and roadmap. Every command and path in it must still work."
	echo "  2. Skills: .claude/skills/*/SKILL.md (installation) and skills/*/SKILL.md (Reelix's own agent):"
	echo "     commands, settings paths, operation names and behaviour they describe."
	echo "  3. The website: website/src/page.ts and website/locales/{en,zh,fr,ru}.json. Claims, commands and"
	echo "     status must match; all four languages change together. Rebuild with: npm run site:build"
	echo "     (deploying it is a separate step the owner asks for)."
	echo "  4. docs/: a document whose behaviour changed changes with it (CLAUDE.md, \"Docs first\")."
	echo "  5. Screenshots (website/assets/shots, used by the README and the website), last taken in ${shots_commit:0:7}."
	if [ -n "$ui_changed" ]; then
		echo "     The web UI changed since then:"
		printf '%s\n' "$ui_changed" | sed 's/^/       /' | head -30
		echo "     If any change is visible on a captured screen (chat, trends, library, title, downloads, inbox,"
		echo "     plugins), retake them for all four languages: see website/shots.ts and website/README.md."
		echo "     If none is visible, say so in your reply, with the reason."
	else
		echo "     Nothing in the web UI changed since then."
	fi
	echo ""
	echo "When everything matches, run this as a command of its own, then retry the $action:"
	echo "  bash .claude/hooks/docs-sync.sh ack"
	echo "Run it only after the check: it records the working tree as it is at that moment."
} >&2
exit 2
