#!/usr/bin/env bash
set -euo pipefail

user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
admin_token_file="${1:-${user_home}/.local/share/kogane/secrets/vpoint-admin-token}"
collector_url="${VPOINT_WORKER_BASE_URL:-https://kogane-vpoint-collector-poc.takuanimal.workers.dev}"
state_dir="${KOGANE_STATE_DIR:-${user_home}/.local/state/kogane}"
cursor_file="${state_dir}/vpoint-raw-evidence-backfill.cursor"
admin_token="$(perl - "${admin_token_file}" <<'PERL'
use strict;
use warnings;
use Fcntl qw(:DEFAULT :mode);

my ($path) = @ARGV;
sysopen(my $handle, $path, O_RDONLY | O_NOFOLLOW)
  or die "admin token file could not be opened safely\n";
my @file_stat = stat($handle);
die "admin token file must be a regular file\n"
  unless @file_stat && S_ISREG($file_stat[2]);
die "admin token file must be owned by the current user\n"
  unless $file_stat[4] == $<;
die "admin token file must have mode 0600\n"
  unless ($file_stat[2] & 07777) == 0600;
my $value = do { local $/; <$handle> };
die "admin token file is empty\n" unless defined($value) && length($value) > 0;
$value =~ s/\r?\n\z//;
die "admin token format is invalid\n"
  if length($value) < 20 || length($value) > 512 || $value =~ /[\x00-\x20\x7f]/;
print $value;
PERL
)"
auth_config="header = \"Authorization: Bearer ${admin_token}\""
unset admin_token
mkdir -p "${state_dir}"
chmod 700 "${state_dir}"
cursor=""
if [[ -s "${cursor_file}" ]]; then IFS= read -r cursor < "${cursor_file}"; fi
page=0
manifest_count=0
deferred_count=0
while (( page < 100000 )); do
  page=$((page + 1))
  url="${collector_url}/backfill-raw-evidence?limit=1"
  if [[ -n "${cursor}" ]]; then
    encoded_cursor="$(jq -rn --arg value "${cursor}" '$value|@uri')"
    url="${url}&cursor=${encoded_cursor}"
  fi
  response="$(curl --config <(printf '%s\n' "${auth_config}") \
    --fail-with-body --silent --show-error --max-time 180 \
    --request POST "${url}")"
  failed="$(jq -er '.failedManifestCount' <<<"${response}")"
  if (( failed != 0 )); then
    jq '{page: $page, failedManifestCount, failureCode}' \
      --argjson page "${page}" <<<"${response}" >&2
    exit 1
  fi
  imported="$(jq -er '.importedManifestCount' <<<"${response}")"
  deferred="$(jq -er '.deferredManifestCount' <<<"${response}")"
  manifest_count=$((manifest_count + imported))
  deferred_count=$((deferred_count + deferred))
  truncated="$(jq -r '.truncated' <<<"${response}")"
  if [[ "${truncated}" == false ]]; then
    rm -f -- "${cursor_file}"
    printf '{"complete":true,"pages":%d,"importedManifests":%d,"deferredManifests":%d}\n' \
      "${page}" "${manifest_count}" "${deferred_count}"
    exit 0
  fi
  cursor="$(jq -er '.nextCursor | select(type == "string" and length > 0)' <<<"${response}")"
  cursor_next="${cursor_file}.next.$$"
  printf '%s\n' "${cursor}" >"${cursor_next}"
  chmod 600 "${cursor_next}"
  mv -f -- "${cursor_next}" "${cursor_file}"
done

printf 'backfill exceeded the safety page limit\n' >&2
exit 1
