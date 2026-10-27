#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/lint.sh
python3 -B -m unittest discover -s tests -p 'test_*.py'
