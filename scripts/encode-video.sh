#!/usr/bin/env bash
# Turns .tooling/video/demo.webm (from scripts/capture-video.ts) into the two files the
# README uses: docs/demo.mp4, the full-quality recording, and docs/demo.gif,
# which GitHub plays inline in the README.
#
# Needs an ffmpeg with libx264. Set FFMPEG to point at one, or put one on PATH.
# `uvx --from imageio-ffmpeg python -c "import imageio_ffmpeg as f; print(f.get_ffmpeg_exe())"`
# prints the path of a static build if there is none on the machine.
set -euo pipefail
cd "$(dirname "$0")/.."
ff="${FFMPEG:-ffmpeg}"

"$ff" -y -v error -i .tooling/video/demo.webm \
  -c:v libx264 -pix_fmt yuv420p -crf 26 -preset slow -movflags +faststart \
  docs/demo.mp4

"$ff" -y -v error -i .tooling/video/demo.webm \
  -vf "fps=8,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=none" \
  docs/demo.gif

ls -lh docs/demo.mp4 docs/demo.gif
