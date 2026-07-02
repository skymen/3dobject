#!/bin/bash
# Unminified release build. Prefer release-minified.sh.
set -e
if [ -z "$1" ]; then
    echo "Usage: $0 <version>"
    exit 1
fi
mkdir -p dist
rm -f "dist/3DObject-$1.c3addon"
cd ./src
zip -r "../dist/3DObject-$1.c3addon" * -x "*.DS_Store"
cd ..
