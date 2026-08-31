#!/usr/bin/env bash
# Echoes the env it was spawned with back through the JSON envelope, so tests
# can assert what runClaudeRecap's env option actually passes to claude.
cat > /dev/null
printf '{"result":"USER=%s PATH_SET=%s"}' "$USER" "${PATH:+yes}"
