#!/usr/bin/env bash
# Returns claude's argv and raw stdin as a JSON-encoded .result, so tests can
# assert exactly what runClaudeRecap passes to claude on both channels
# (the -p prompt with its fence markers, and the fenced stdin payload).
node -e 'let d="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify({result:JSON.stringify({argv:process.argv.slice(1),stdin:d})})))' -- "$@"
