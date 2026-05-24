module.exports = {
  apps: [
    {
      name: "minecraft-ai-bot",
      script: "./dist/index.mjs",
      instances: 1,
      exec_mode: "fork",
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        DATA_DIR: "./data",
      },
      error_file: "./logs/pm2-error.log",
      out_file: "./logs/pm2-out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      restart_delay: 5000,
      max_restarts: 20,
      min_uptime: "10s",
      autorestart: true,
      exp_backoff_restart_delay: 100,
      node_args: "--enable-source-maps",
    },
  ],
};
