#!/usr/bin/env bash
# GnomeFootball — produces a ZIP suitable for upload to extensions.gnome.org.
#
# The ZIP is built from a clean staging directory containing only the files
# that the extension needs at runtime (no .po sources, no scripts).

set -euo pipefail

UUID="gnomefootball@carlos.j.delgado"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SRC_DIR}/build"
STAGE_DIR="${BUILD_DIR}/${UUID}"
OUT_ZIP="${BUILD_DIR}/${UUID}.shell-extension.zip"

cd "${SRC_DIR}"

echo "==> Compiling GSettings schemas"
glib-compile-schemas schemas/

echo "==> Building locale .mo files"
mkdir -p locale
for po in po/*.po; do
    lang="$(basename "${po}" .po)"
    target_dir="locale/${lang}/LC_MESSAGES"
    mkdir -p "${target_dir}"
    msgfmt "${po}" -o "${target_dir}/gnomefootball.mo"
done

echo "==> Staging files"
rm -rf "${BUILD_DIR}"
mkdir -p "${STAGE_DIR}"

cp metadata.json "${STAGE_DIR}/"
cp extension.js "${STAGE_DIR}/"
cp prefs.js "${STAGE_DIR}/"
cp stylesheet.css "${STAGE_DIR}/"
cp -r lib "${STAGE_DIR}/"
cp -r schemas "${STAGE_DIR}/"
cp -r locale "${STAGE_DIR}/"

echo "==> Creating ZIP"
( cd "${STAGE_DIR}" && zip -qr "${OUT_ZIP}" . )

echo
echo "Package ready: ${OUT_ZIP}"
