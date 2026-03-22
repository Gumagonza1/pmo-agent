module.exports = {
  apps: [
    {
      name: 'pmo-agent',
      script: 'index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '256M',
      error_file: '../logs/pmo-error.log',
      out_file: '../logs/pmo-out.log',
      restart_delay: 10000,
      max_restarts: 5,
    },
  ],
};
