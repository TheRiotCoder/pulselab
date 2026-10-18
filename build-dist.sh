#!/bin/sh
# Copies only the files the app needs into a clean dist directory (no tests, docs or dev files).
set -e
OUT="${1:-/workspace/pulselab-dist}"
rm -rf "$OUT" && mkdir -p "$OUT"
cd "$(dirname "$0")"
cp index.html styles.css manifest.webmanifest sw.js _headers "$OUT"/
cp -r js vendor icons "$OUT"/
echo "built $OUT ($(find "$OUT" -type f | wc -l) files)"
