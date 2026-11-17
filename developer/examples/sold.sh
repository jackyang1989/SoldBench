#!/bin/sh
# curl performs HTTP; Python standard library handles bounded polling and JSON.
# Keep sold.py alongside this file. --claim explicitly permits up to one credit.
set -eu
umask 077
exec python3 "$(dirname "$0")/sold.py" --transport=curl "$@"
