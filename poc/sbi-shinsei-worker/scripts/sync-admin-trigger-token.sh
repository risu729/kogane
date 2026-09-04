#!/usr/bin/env bash
set -euo pipefail

export CLOUDFLARE_ACCOUNT_ID="59ea63cc00914b30ca410b062ae2bb7f"

usage() {
  printf 'usage: %s --sync|--rotate|--resume\n' "${0##*/}" >&2
  exit 2
}

mode="${1:-}"
[[ $# -eq 1 ]] || usage
case "${mode}" in
  --sync|--rotate|--resume) ;;
  *) usage ;;
esac

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_dir="$(cd -- "${script_dir}/.." && pwd)"
user_home="$(getent passwd "$(id -u)" | cut -d: -f6)"
token_file="${SBI_SHINSEI_ADMIN_TOKEN_FILE:-${user_home}/.local/share/kogane/secrets/sbi-shinsei-worker-admin-token}"
pending_file="${token_file}.pending"
token_dir="$(dirname -- "${token_file}")"
wrangler_bin="${WRANGLER_BIN:-${service_dir}/node_modules/.bin/wrangler}"
openssl_bin="${OPENSSL_BIN:-openssl}"
secret_name="ADMIN_TRIGGER_TOKEN"

if ! test -x "${wrangler_bin}"; then
  printf 'local wrangler executable is missing\n' >&2
  exit 1
fi
if ! command -v "${openssl_bin}" >/dev/null 2>&1; then
  printf 'openssl executable is missing\n' >&2
  exit 1
fi

mkdir -p -- "${token_dir}"
if [[ -L "${token_dir}" || ! -d "${token_dir}" ]]; then
  printf 'admin token directory must be a non-symlink directory: %s\n' "${token_dir}" >&2
  exit 1
fi
if [[ "$(stat -c '%u' -- "${token_dir}")" != "$(id -u)" ]]; then
  printf 'admin token directory must be owned by the current user: %s\n' "${token_dir}" >&2
  exit 1
fi
chmod 700 -- "${token_dir}"

stream_token() {
  perl - "${1}" <<'PERL'
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
$value =~ s/\r?\n\z// if defined($value);
die "admin token format is invalid\n"
  unless defined($value)
    && length($value) >= 32
    && length($value) <= 512
    && $value !~ /[\x00-\x20\x7f]/;
print $value;
PERL
}

temp_file=""
cleanup() {
  if [[ -n "${temp_file}" && -e "${temp_file}" ]]; then
    rm -f -- "${temp_file}"
  fi
}
trap cleanup EXIT

case "${mode}" in
  --sync)
    if [[ -e "${pending_file}" || -L "${pending_file}" ]]; then
      printf 'pending admin token must be recovered first with --resume: %s\n' \
        "${pending_file}" >&2
      exit 1
    fi
    source_file="${token_file}"
    ;;
  --rotate)
    if [[ -e "${pending_file}" || -L "${pending_file}" ]]; then
      printf 'pending admin token already exists; use --resume: %s\n' \
        "${pending_file}" >&2
      exit 1
    fi
    umask 077
    temp_file="$(mktemp "${token_file}.tmp.XXXXXX")"
    "${openssl_bin}" rand -hex 32 >"${temp_file}"
    chmod 600 -- "${temp_file}"
    stream_token "${temp_file}" >/dev/null
    if ! ln -- "${temp_file}" "${pending_file}"; then
      printf 'could not create pending admin token atomically: %s\n' \
        "${pending_file}" >&2
      exit 1
    fi
    rm -f -- "${temp_file}"
    temp_file=""
    source_file="${pending_file}"
    ;;
  --resume)
    source_file="${pending_file}"
    ;;
esac

# Do not start Wrangler unless the selected local file is already safe and valid.
stream_token "${source_file}" >/dev/null
if ! (
  cd -- "${service_dir}"
  stream_token "${source_file}" |
    "${wrangler_bin}" secret put "${secret_name}" >/dev/null 2>&1
); then
  if [[ "${mode}" == "--rotate" || "${mode}" == "--resume" ]]; then
    printf 'secret sync failed; pending admin token retained for --resume: %s\n' \
      "${pending_file}" >&2
  else
    printf 'secret sync failed; local admin token was not changed: %s\n' \
      "${token_file}" >&2
  fi
  exit 1
fi

if [[ "${mode}" == "--rotate" || "${mode}" == "--resume" ]]; then
  if ! mv -f -- "${pending_file}" "${token_file}"; then
    printf 'remote secret was updated; pending token retained for --resume: %s\n' \
      "${pending_file}" >&2
    exit 1
  fi
fi

printf 'synced secret %s from %s\n' "${secret_name}" "${token_file}"
