module.exports = {
  apps: [
    {
      name: 'unitnavigator',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
