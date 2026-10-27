#!/bin/sh
# The ONE simulated part of the proof: kexec would replace the running kernel.
# This records exactly what it was asked to load and returns success.
printf '%s\n' "$*" >> /work/kexec.log
exit 0
