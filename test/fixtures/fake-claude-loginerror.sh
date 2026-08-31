#!/usr/bin/env bash
# Mimics claude in --output-format json when not authenticated: the error is
# the envelope's .result on stdout, stderr stays empty, exit code 1.
cat > /dev/null
echo '{"is_error":true,"result":"Not logged in · Please run /login"}'
exit 1
