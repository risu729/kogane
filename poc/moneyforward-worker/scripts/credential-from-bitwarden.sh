#!/usr/bin/env bash
set -euo pipefail

bw_cli=${BW_CLI:-/home/risu/.local/share/mise/installs/bitwarden/2026.8.0/bw}
match_file=${1:-/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json}

if [[ ! -x $bw_cli ]]; then
  echo "Bitwarden CLI is not available" >&2
  exit 1
fi
if [[ -z ${BW_SESSION:-} ]]; then
  echo "BW_SESSION is required; unlock Bitwarden locally first" >&2
  exit 1
fi
if [[ ! -s $match_file ]]; then
  echo "Money Forward Bitwarden match metadata is required" >&2
  exit 1
fi

item=$(jq -er '.itemId' "$match_file")
credential_index=$(jq -er '.credentialIndex' "$match_file")

"$bw_cli" get item "$item" --session "$BW_SESSION" | jq -ce '
  .login.fido2Credentials[$credential_index] as $credential |
  if $credential.rpId != "id.moneyforward.com" then error("matched credential is not a Money Forward passkey") else
    $credential | {
      rpId,
      origin: "https://id.moneyforward.com",
      credentialId,
      keyValue,
      userHandle,
      counter: (.counter | tonumber)
    }
  end
' --argjson credential_index "$credential_index"
