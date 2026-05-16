#!/usr/bin/env bash

set -euo pipefail

if [[ $# -lt 1 ]]; then
  printf 'Usage: %s <primary-hostname-or-ip> [additional-hostname-or-ip ...]\n' "$0"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT_DIR/containers/nginx/certs"
CERT_PATH="$CERT_DIR/evigstudio.crt"
KEY_PATH="$CERT_DIR/evigstudio.key"
OPENSSL_CONFIG="$CERT_DIR/openssl-lan.cnf"

mkdir -p "$CERT_DIR"

PRIMARY_NAME="$1"
shift
ALL_NAMES=("$PRIMARY_NAME" "$@")

cat >"$OPENSSL_CONFIG" <<EOF
[req]
default_bits = 4096
prompt = no
default_md = sha256
x509_extensions = v3_req
distinguished_name = dn

[dn]
CN = ${PRIMARY_NAME}

[v3_req]
subjectAltName = @alt_names
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt_names]
EOF

index=1
for name in "${ALL_NAMES[@]}"; do
  if [[ "$name" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    printf 'IP.%d = %s\n' "$index" "$name" >>"$OPENSSL_CONFIG"
  else
    printf 'DNS.%d = %s\n' "$index" "$name" >>"$OPENSSL_CONFIG"
  fi
  index=$((index + 1))
done

openssl req \
  -x509 \
  -nodes \
  -days 825 \
  -newkey rsa:4096 \
  -keyout "$KEY_PATH" \
  -out "$CERT_PATH" \
  -config "$OPENSSL_CONFIG"

printf 'Generated certificate:\n'
printf '  cert: %s\n' "$CERT_PATH"
printf '  key : %s\n' "$KEY_PATH"
printf '\nImportant: trust this certificate on each client device, otherwise the browser will still warn about it.\n'
