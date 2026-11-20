#!/bin/sh
# One line per download Reelix looks after: state, upload ratio, name (tab-separated).
# Runs in the agent's shell, with the agent's own token, like any command the agent types.
set -eu
reelix download status --json | jq -r '.[] | [.state, ((.live.ratio // "-") | tostring), .name] | @tsv'
