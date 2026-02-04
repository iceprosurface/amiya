const path = require('path')

const targetDir = process.env.AMIYA_TARGET_DIR || __dirname

module.exports = {
  apps: [
    {
      name: "amiya",
      script: path.join(__dirname, "dist/index.js"),
      cwd: targetDir,
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        AMIYA_TARGET_DIR: targetDir,
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        no_proxy: "localhost,127.0.0.1,.feishu.cn,.larksuite.com,.larkoffice.com",
      },
    },
  ],
};
