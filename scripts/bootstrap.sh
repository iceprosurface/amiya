#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

print() { printf "%s\n" "$*"; }
fail() { print "Error: $*"; exit 1; }

as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "sudo not available; cannot run: $*"
  fi
}

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_bash_profile() {
  local shell_name="${SHELL##*/}"
  if [[ "$shell_name" == "zsh" ]]; then
    echo "$HOME/.zshrc"
  else
    echo "$HOME/.bashrc"
  fi
}

ensure_curl() {
  if command -v curl >/dev/null 2>&1; then
    return 0
  fi
  print "Installing curl..."
  if command -v apt-get >/dev/null 2>&1; then
    as_root apt-get update -y
    as_root apt-get install -y curl
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y curl
  elif command -v yum >/dev/null 2>&1; then
    as_root yum install -y curl
  else
    fail "curl not found and no supported package manager available."
  fi
}

install_nvm() {
  if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
    return 0
  fi
  print "Installing nvm..."
  ensure_curl
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
}

load_nvm() {
  # shellcheck disable=SC1090
  [[ -s "$HOME/.nvm/nvm.sh" ]] && . "$HOME/.nvm/nvm.sh"
}

ensure_node() {
  local node_version="24"
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p "process.versions.node.split('.')[0]")"
    if [[ "$current_major" == "$node_version" ]]; then
      return 0
    fi
  fi

  install_nvm
  load_nvm
  command -v nvm >/dev/null 2>&1 || fail "nvm not available after install."
  nvm install "$node_version"
  nvm use "$node_version"

  local profile
  profile="$(ensure_bash_profile)"
  if [[ -f "$profile" ]] && ! grep -q "NVM_DIR" "$profile"; then
    print "Configuring shell profile: $profile"
    {
      echo 'export NVM_DIR="$HOME/.nvm"'
      echo '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"'
    } >> "$profile"
  fi
}

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  print "Installing pnpm..."
  npm install -g pnpm
}

ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return 0
  fi
  print "Installing pm2..."
  npm install -g pm2
}

ensure_opencode() {
  if command -v opencode >/dev/null 2>&1; then
    return 0
  fi
  local install_cmd="${OPENCODE_INSTALL_CMD:-}"
  if [[ -n "$install_cmd" ]]; then
    print "Installing opencode CLI using: $install_cmd"
    eval "$install_cmd"
  else
    print "Installing opencode CLI..."
    npm install -g opencode-ai
  fi
  command -v opencode >/dev/null 2>&1 || fail "opencode CLI not found after install. Set OPENCODE_INSTALL_CMD to the correct install command."
}

opencode_login() {
  if is_truthy "${AMIYA_NON_INTERACTIVE:-}"; then
    print "Skipping opencode auth login in non-interactive mode."
    return 0
  fi
  print "Running opencode auth login..."
  opencode auth login
}

prompt() {
  local var_name="$1"
  local label="$2"
  local default="${3:-}"
  local value=""
  if is_truthy "${AMIYA_NON_INTERACTIVE:-}"; then
    value="${!var_name:-$default}"
  else
    read -r -p "${label}${default:+ [$default]}: " value || true
    value="${value:-$default}"
  fi
  printf -v "$var_name" "%s" "$value"
}

split_csv() {
  local input="${1:-}"
  if [[ -z "$input" ]]; then
    echo "[]"
    return 0
  fi
  local items=()
  IFS=',' read -r -a items <<< "$input"
  local json="["
  local first=1
  for item in "${items[@]}"; do
    item="$(echo "$item" | xargs)"
    [[ -z "$item" ]] && continue
    if [[ $first -eq 0 ]]; then
      json+=", "
    fi
    json+="\"$item\""
    first=0
  done
  json+="]"
  echo "$json"
}

ensure_target_dir() {
  if [[ -n "${AMIYA_TARGET_DIR:-}" ]]; then
    TARGET_DIR="$AMIYA_TARGET_DIR"
  else
    TARGET_DIR="${1:-}"
  fi
  [[ -n "$TARGET_DIR" ]] || fail "Target directory required. Usage: scripts/bootstrap.sh /path/to/project"
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
}

generate_config() {
  local data_dir="$TARGET_DIR/.amiya"
  local config_path="$data_dir/feishu.json"
  local source_path="$data_dir/source.md"

  mkdir -p "$data_dir"

  prompt PROVIDER "Provider (feishu only for now)" "feishu"
  if [[ "$PROVIDER" != "feishu" ]]; then
    fail "Provider '$PROVIDER' is not supported yet. Use 'feishu'."
  fi

  if [[ -f "$config_path" ]]; then
    print "feishu.json already exists: $config_path"
  else
    print "Generating feishu.json..."
    prompt FEISHU_APP_ID "Feishu appId"
    prompt FEISHU_APP_SECRET "Feishu appSecret"
    prompt FEISHU_BOT_USER_ID "Feishu botUserId (optional)"
    prompt FEISHU_ADMIN_CHAT_ID "Feishu adminChatId (optional)"
    prompt FEISHU_ADMIN_USER_IDS "Feishu adminUserIds (comma-separated, optional)"
    prompt FEISHU_ALLOWED_CHAT_IDS "Feishu allowedChatIds (comma-separated, optional)"
    prompt FEISHU_REQUIRE_USER_WHITELIST "requireUserWhitelist (true/false)" "false"
    prompt FEISHU_USE_LARK "useLark (true/false)" "false"
    prompt FEISHU_DEBUG "debug (true/false)" "true"
    prompt FEISHU_MODEL "default model (provider/model, optional)"

    [[ -n "$FEISHU_APP_ID" ]] || fail "Feishu appId is required."
    [[ -n "$FEISHU_APP_SECRET" ]] || fail "Feishu appSecret is required."

    local admin_users_json
    admin_users_json="$(split_csv "$FEISHU_ADMIN_USER_IDS")"
    local allowed_chats_json
    allowed_chats_json="$(split_csv "$FEISHU_ALLOWED_CHAT_IDS")"

    cat > "$config_path" <<EOF
{
  "appId": "$FEISHU_APP_ID",
  "appSecret": "$FEISHU_APP_SECRET",
  "useLark": $(is_truthy "$FEISHU_USE_LARK" && echo true || echo false),
  "adminUserIds": $admin_users_json,
  "adminChatId": "$FEISHU_ADMIN_CHAT_ID",
  "botUserId": "$FEISHU_BOT_USER_ID",
  "allowedChatIds": $allowed_chats_json,
  "requireUserWhitelist": $(is_truthy "$FEISHU_REQUIRE_USER_WHITELIST" && echo true || echo false),
  "debug": $(is_truthy "$FEISHU_DEBUG" && echo true || echo false),
  "model": "$FEISHU_MODEL"
}
EOF
  fi

  if [[ ! -f "$source_path" ]]; then
    cat > "$source_path" <<EOF
# Agent Source

Please customize this file with your agent instructions.
EOF
    print "Generated default agent source at: $source_path"
  fi
}

generate_pm2_files() {
  local data_dir="$TARGET_DIR/.amiya"
  local bootstrap_path="$data_dir/bootstrap.sh"
  local config_path="$data_dir/pm2.config.cjs"
  local dist_entry="$ROOT_DIR/dist/index.js"

  cat > "$bootstrap_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
node "$dist_entry" "$TARGET_DIR"
EOF
  chmod +x "$bootstrap_path"

  cat > "$config_path" <<EOF
module.exports = {
  apps: [
    {
      name: "amiya",
      script: "$bootstrap_path",
      cwd: "$ROOT_DIR",
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
EOF
}

start_pm2() {
  print "Installing dependencies..."
  local install_flags=()
  if is_truthy "${AMIYA_NON_INTERACTIVE:-}"; then
    install_flags+=(--force --no-frozen-lockfile)
    printf "y\n" | pnpm install "${install_flags[@]}"
  else
    pnpm install "${install_flags[@]}"
  fi
  print "Building..."
  pnpm run build
  print "Starting PM2..."
  pm2 start "$TARGET_DIR/.amiya/pm2.config.cjs"
  pm2 save
}

main() {
  ensure_target_dir "${1:-}"
  ensure_node
  ensure_pnpm
  ensure_pm2
  ensure_opencode
  opencode_login
  generate_config
  generate_pm2_files
  start_pm2
  print "Bootstrap complete."
}

main "$@"
