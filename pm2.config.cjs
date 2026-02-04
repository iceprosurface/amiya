module.exports = {
  apps: [
    {
      name: "amiya",
      script: "dist/index.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        no_proxy: "localhost,127.0.0.1,.feishu.cn,.larksuite.com,.larkoffice.com",
      },
    },
  ],
};
