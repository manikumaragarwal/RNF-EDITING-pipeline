#!/usr/bin/env bash
# push-drive.sh — copy a gathered footage folder up to Google Drive.
#
#   bash push-drive.sh <local-dir> <drive-folder-name>
#
# Uploads <local-dir>/* to gdrive:<drive-folder-name>/ using the box's existing
# rclone `gdrive:` remote (no wrapper needed — the token lives in rclone.conf).
# Prints the Drive folder path. Never runs `rclone link` (public share) — the
# folder is handed over via the Drive UI / an open?id link by the operator.
set -euo pipefail

RCLONE="${RCLONE:-rclone}"
LOCAL_DIR="${1:?usage: push-drive.sh <local-dir> <drive-folder-name>}"
DRIVE_FOLDER="${2:?usage: push-drive.sh <local-dir> <drive-folder-name>}"

[ -d "$LOCAL_DIR" ] || { echo "local dir not found: $LOCAL_DIR" >&2; exit 1; }

"$RCLONE" mkdir "gdrive:${DRIVE_FOLDER}"
"$RCLONE" copy "$LOCAL_DIR" "gdrive:${DRIVE_FOLDER}/" \
  --transfers 4 --checkers 8 --drive-chunk-size 32M --stats-one-line

echo "uploaded to gdrive:${DRIVE_FOLDER}/"
