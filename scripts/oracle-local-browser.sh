#!/usr/bin/env bash
set -euo pipefail

: "${ORACLE_HOME_DIR:=$HOME/.oracle-local}"
export ORACLE_HOME_DIR

exec oracle --engine browser --browser-keep-browser "$@"
