module.exports = {
  apps: [
    {
      name: "amiya",
      script: "dist/index.js",
      cwd: __dirname,
      args: [process.env.AMIYA_TARGET_DIR || __dirname],
      instances: 1,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
