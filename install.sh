#!/usr/bin/env bash
# GnomeFootball — local install script.
#
# Compiles GSettings schemas, builds .mo files from the .po sources, then
# symlinks this directory into ~/.local/share/gnome-shell/extensions/<uuid>.
# Useful for development: edits to the source tree are reflected immediately
# (a Shell restart is still needed on Wayland).

set -euo pipefail

UUID="gnomefootball@carlos.j.delgado"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

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

echo "==> Linking extension into ${EXT_DIR}"
mkdir -p "$(dirname "${EXT_DIR}")"
if [ -e "${EXT_DIR}" ] || [ -L "${EXT_DIR}" ]; then
    rm -rf "${EXT_DIR}"
fi
ln -s "${SRC_DIR}" "${EXT_DIR}"

echo
echo "Extension installed at: ${EXT_DIR}"
echo
echo "Next steps:"
echo "  - X11:     restart the Shell with Alt+F2, type 'r', press Enter."
echo "  - Wayland: log out and back in (or reboot)."
echo "  - Then:    gnome-extensions enable ${UUID}"
echo "             gnome-extensions prefs ${UUID}"
