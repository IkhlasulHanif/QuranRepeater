#!/bin/zsh -l
set -e
cd "${0:A:h}"
if ! command -v npm >/dev/null 2>&1; then
  print 'Node.js is required. Install Node.js 22.12 or newer from https://nodejs.org, then open this file again.'
  read 'reply?Press Enter to close.'
  exit 1
fi
npm run init
