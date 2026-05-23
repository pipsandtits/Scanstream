// Explicit CommonJS Prisma config for CLI: used with `--config` flag
module.exports = {
  datasources: {
    db: {
      provider: 'postgresql',
      url: process.env.DATABASE_URL,
    },
  },
};
