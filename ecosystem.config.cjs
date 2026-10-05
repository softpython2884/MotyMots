// PM2 : `pm2 startOrReload ecosystem.config.cjs` (ou `npm run prod`).
// Un seul processus, volontairement : l'état de la partie vit en mémoire, il ne se partage pas entre instances.
module.exports = {
  apps: [
    {
      name: 'motymots',
      script: 'server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '600M', // le mode « 4 langues » charge cinq listes : 150 à 250 Mo
      time: true, // horodate les logs
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1', // uniquement joignable via nginx
        PORT: process.env.PORT || 3000,
      },
    },
  ],
};
