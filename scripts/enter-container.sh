#!/usr/bin/env bash
set -euo pipefail

group=${1:-main}
shift || true

repo_root=$(pwd)

if [[ ! -d "${repo_root}/.amiya" ]]; then
  echo "Run this script from the repo root (missing .amiya directory)." >&2
  exit 1
fi

data_dir="${repo_root}/.amiya/workspace/data"
group_dir="${repo_root}/.amiya/workspace/groups/${group}"
sessions_dir="${data_dir}/sessions/${group}/.opencode"
ipc_dir="${data_dir}/ipc/${group}"
opencode_global="${repo_root}/.amiya/opencode-global"
opencode_share="${repo_root}/.amiya/opencode-share"
opencode_log="${data_dir}/opencode-log/${group}"

mkdir -p "${group_dir}" "${sessions_dir}" "${ipc_dir}" "${opencode_log}"

image=${CONTAINER_IMAGE:-opencode-agent:latest}

args=(container run -it --rm)

args+=(-v "${repo_root}:/workspace/project")
args+=(-v "${group_dir}:/workspace/group")
args+=(-v "${sessions_dir}:/home/node/.opencode")
args+=(-v "${ipc_dir}:/workspace/ipc")
args+=(-v "${opencode_log}:/root/.local/share/opencode/log")

if [[ -d "${opencode_global}" ]]; then
  args+=(--mount "type=bind,source=${opencode_global},target=/workspace/opencode-global,readonly")
fi

if [[ -d "${opencode_share}" ]]; then
  args+=(--mount "type=bind,source=${opencode_share},target=/workspace/opencode-share,readonly")
fi

args+=("${image}")

setup_cmd=""
setup_cmd+="mkdir -p /root/.config/opencode /root/.local/share/opencode; "
setup_cmd+="if [ -f /workspace/opencode-share/auth.json ]; then cp -n /workspace/opencode-share/auth.json /root/.local/share/opencode/auth.json; fi; "
setup_cmd+="if [ -d /workspace/opencode-global ]; then cp -n /workspace/opencode-global/* /root/.config/opencode/ 2>/dev/null || true; fi; "

if [[ $# -eq 0 ]]; then
  args+=(/bin/bash -lc "${setup_cmd} exec /bin/bash")
else
  args+=(/bin/bash -lc "${setup_cmd} exec $*")
fi

exec "${args[@]}"
