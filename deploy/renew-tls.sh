#!/bin/sh
# Run on the home server; only the Ante Up certificate is managed here.
# NPM's own certificates retain their existing renewal job.
set -eu
exec docker exec npm certbot renew --cert-name ante-up.fun --quiet --deploy-hook 'nginx -t && nginx -s reload'
