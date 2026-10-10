#!/usr/bin/env bash
# Median wall time of a command. usage: scripts/bench.sh <runs> <cmd...>
n=$1; shift; ts=()
for i in $(seq $n); do s=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000'); "$@" >/dev/null 2>&1 </dev/null; e=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000'); ts+=($((e-s))); done
printf "%s\n" "${ts[@]}" | sort -n | awk '{a[NR]=$1} END{print "median", a[int((NR+1)/2)], "ms min", a[1]}'
