---
name: seeding-report
description: Report how the owner's downloads are seeding (state, upload ratio) and which finished ones could go. Use when the owner asks about seeding, ratios, or what can be cleaned up in the download folder.
---
# Seeding report

1. Run `scripts/report.sh` (in this skill's folder). It prints one line per download Reelix looks after: state, upload ratio (`-` when qBittorrent does not say), name.
2. Summarise for the owner: how many are still downloading, how many seed and their ratios, and the finished ones with a ratio of 1 or more, which are the usual candidates to remove.
3. Removing is the owner's decision. Name the candidates and wait; never remove a download because this report lists it.
