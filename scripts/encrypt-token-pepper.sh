#!/usr/bin/env bash
# Mint a kms-mode token pepper for one region and print the base64
# CiphertextBlob you paste into MIDPLANE_TOKEN_PEPPER_CT_<REGION>_V1.
#
# Usage:
#   scripts/encrypt-token-pepper.sh <region> <CMK ARN>
#
# Region must be eu or us. The CMK must be the same one referenced by
# MIDPLANE_KMS_KEY_<REGION> in prod (the pepper-load path Decrypt-s with
# whatever ARN that env var points at).
#
# EncryptionContext is bound to {region, purpose=token-pepper} — the loader
# in packages/kms/src/kms-mode.ts decryptPepperKms passes the same pair, so
# any deviation (wrong region, wrong purpose) fails at the KMS boundary.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <eu|us> <CMK ARN>" >&2
  exit 1
fi

region="$1"
arn="$2"

case "$region" in
  eu) aws_region="eu-central-1" ;;
  us) aws_region="us-east-2" ;;
  *) echo "region must be 'eu' or 'us' (got '$region')" >&2; exit 1 ;;
esac

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
openssl rand 32 > "$tmp"

aws kms encrypt \
  --region "$aws_region" \
  --key-id "$arn" \
  --plaintext "fileb://$tmp" \
  --encryption-context "region=$region,purpose=token-pepper" \
  --output text \
  --query CiphertextBlob
