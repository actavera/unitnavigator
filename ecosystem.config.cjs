module.exports = {
  apps: [
    {
      name: 'unitnavigator',
      script: 'server.js',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        STIRLING_PDF_URL: 'http://127.0.0.1:8085',
      },
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
